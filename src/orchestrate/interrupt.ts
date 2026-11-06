import {
	appendRunEvent,
	readRunRecord,
	recordInterruptRequest,
	type RunAttemptRecord,
	type RunRecord,
} from "../artifacts/index.ts";
import { resolveRunRef } from "./run-ref.ts";
import { reconcileSubagentRun } from "./reconcile.ts";
import { isTerminalStatus } from "./status.ts";
import {
	type ProcessIdentity,
	verifyProcessIdentity,
} from "../process-identity.ts";

export interface InterruptRunOptions {
	cwd?: string;
	runId: string;
	runsDir?: string;
	attemptId?: string;
	/** @deprecated v1 compatibility alias. */
	taskId?: string;
	reason?: string;
	signal?: NodeJS.Signals;
	escalateAfterMs?: number;
	killAfterMs?: number;
}

export interface InterruptRunResult {
	status:
		| "interrupt-requested"
		| "not-found"
		| "already-terminal"
		| "unsupported";
	runId: string;
	signal: NodeJS.Signals;
	interruptedAttempts: string[];
	unsupportedAttempts: string[];
	/** @deprecated v1 compatibility alias. */
	interruptedTasks: string[];
	/** @deprecated v1 compatibility alias. */
	unsupportedTasks: string[];
	record: RunRecord | null;
}

interface VerifiedInterruptTarget {
	identity: ProcessIdentity;
	target: number;
	/** The durable worker process, as opposed to the model child it runs. */
	worker?: boolean;
}

function interruptIdentities(attempt: RunAttemptRecord): ProcessIdentity[] {
	const identities: ProcessIdentity[] = [];
	if (
		attempt.process?.pid !== undefined &&
		attempt.process.processGroupId !== undefined &&
		attempt.process.processBirthIdentity !== undefined
	)
		identities.push({
			pid: attempt.process.pid,
			processGroupId: attempt.process.processGroupId,
			birthIdentity: attempt.process.processBirthIdentity,
		});
	if (
		attempt.process?.workerPid !== undefined &&
		attempt.process.workerProcessGroupId !== undefined &&
		attempt.process.workerProcessBirthIdentity !== undefined
	)
		identities.push({
			pid: attempt.process.workerPid,
			processGroupId: attempt.process.workerProcessGroupId,
			birthIdentity: attempt.process.workerProcessBirthIdentity,
		});
	return identities;
}

async function verifyInterruptTargets(
	attempt: RunAttemptRecord,
): Promise<VerifiedInterruptTarget[]> {
	const targets = new Map<number, VerifiedInterruptTarget>();
	for (const identity of interruptIdentities(attempt)) {
		if ((await verifyProcessIdentity(identity)) !== "alive") continue;
		const target =
			process.platform === "win32" ||
			identity.processGroupId !== identity.pid
				? identity.pid
				: -identity.processGroupId;
		targets.set(target, {
			identity,
			target,
			worker:
				identity.pid === attempt.process?.workerPid &&
				identity.pid !== attempt.process?.pid,
		});
	}
	return [...targets.values()];
}

/**
 * Windows has no catchable SIGTERM: process.kill() terminates the process at
 * once. Killing the durable worker that way leaves its attempt without a
 * terminal result, because only the worker records it, and killing only the
 * model child makes the worker record a failure instead of a cancellation.
 * So on win32 a graceful request (initial or SIGTERM escalation) for an
 * attempt with a live worker signals nothing: interruptRun records the
 * request, the worker sees it and cancels itself (stopping its model child)
 * as a POSIX SIGTERM would make it do. SIGKILL escalation still ends every
 * target, and then finalizes an attempt the worker did not finish (see
 * escalate). Without a live worker a graceful signal stops only the model
 * child. POSIX delivers the signal to every target as before.
 */
async function win32WorkerObservesInterrupt(
	targets: readonly VerifiedInterruptTarget[],
	signal: NodeJS.Signals,
): Promise<boolean> {
	if (process.platform !== "win32" || signal === "SIGKILL") return false;
	const worker = targets.find((target) => target.worker === true);
	return (
		worker !== undefined &&
		(await verifyProcessIdentity(worker.identity)) === "alive"
	);
}

function win32GracefulTargets(
	targets: readonly VerifiedInterruptTarget[],
	signal: NodeJS.Signals,
): readonly VerifiedInterruptTarget[] {
	if (process.platform !== "win32" || signal === "SIGKILL") return targets;
	const children = targets.filter((target) => target.worker !== true);
	return children.length > 0 ? children : targets;
}

async function signalVerifiedTargets(
	allTargets: readonly VerifiedInterruptTarget[],
	signal: NodeJS.Signals,
): Promise<boolean> {
	if (await win32WorkerObservesInterrupt(allTargets, signal)) return true;
	let signalled = false;
	const targets = win32GracefulTargets(allTargets, signal);
	for (const { identity, target } of targets) {
		if ((await verifyProcessIdentity(identity)) !== "alive") continue;
		try {
			process.kill(target, signal);
			signalled = true;
		} catch (error) {
			// ESRCH: already gone. EPERM: macOS refuses signals to a group that
			// holds only an unreaped zombie; treat the target as not signalled so
			// escalation and liveness checks decide instead of failing the call.
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ESRCH" && code !== "EPERM") throw error;
		}
	}
	return signalled;
}

function runningAttempts(
	record: RunRecord,
	targetAttemptId?: string,
): RunAttemptRecord[] {
	return record.attempts.filter((attempt) => {
		if (targetAttemptId !== undefined && attempt.attemptId !== targetAttemptId)
			return false;
		return attempt.status === "running" || attempt.status === "pending";
	});
}

async function escalate(
	options: InterruptRunOptions,
	signal: NodeJS.Signals,
	verifiedTargets: ReadonlyMap<string, readonly VerifiedInterruptTarget[]>,
): Promise<void> {
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref).catch(() => null);
	if (record === null || isTerminalStatus(record.status)) return;
	for (const attempt of runningAttempts(
		record,
		options.attemptId ?? options.taskId,
	))
		await signalVerifiedTargets(
			verifiedTargets.get(attempt.attemptId) ?? [],
			signal,
		);
	await appendRunEvent(ref, {
		type: "run.interrupt_requested",
		status: record.status,
		message: `interrupt escalation ${signal}`,
		data: { signal },
	}).catch(() => undefined);
	// win32: SIGKILL ended a worker that had not recorded a result (one that
	// does not watch for the request). Nothing else would finalize the attempt,
	// so once its processes are gone let reconcile mark it cancelled, as
	// interruptRun does for an attempt found with every process gone.
	if (process.platform === "win32" && signal === "SIGKILL")
		await finalizeWin32KilledAttempts(ref, verifiedTargets).catch(() => undefined);
}

async function finalizeWin32KilledAttempts(
	ref: Awaited<ReturnType<typeof resolveRunRef>>,
	verifiedTargets: ReadonlyMap<string, readonly VerifiedInterruptTarget[]>,
): Promise<void> {
	const targets = [...verifiedTargets.values()].flat();
	for (let index = 0; index < 40; index += 1) {
		const states = await Promise.all(
			targets.map((target) => verifyProcessIdentity(target.identity)),
		);
		if (states.every((state) => state !== "alive")) break;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
	const record = await readRunRecord(ref).catch(() => null);
	if (record === null || isTerminalStatus(record.status)) return;
	await reconcileSubagentRun({ ...ref, staleAfterMs: 0 });
}

function result(
	status: InterruptRunResult["status"],
	runId: string,
	signal: NodeJS.Signals,
	interruptedAttempts: string[],
	unsupportedAttempts: string[],
	record: RunRecord | null,
): InterruptRunResult {
	return {
		status,
		runId,
		signal,
		interruptedAttempts,
		unsupportedAttempts,
		interruptedTasks: interruptedAttempts,
		unsupportedTasks: unsupportedAttempts,
		record,
	};
}

export async function interruptRun(
	options: InterruptRunOptions,
): Promise<InterruptRunResult> {
	// SIGTERM is the graceful stop for a headless Pi child: it aborts the
	// running tool, kills the tool's subprocesses, and exits. SIGINT makes Pi
	// die immediately and orphans tool subprocesses (observed on Pi 0.84).
	const signal = options.signal ?? "SIGTERM";
	const ref = await resolveRunRef(options);
	const record = await readRunRecord(ref);
	if (record === null) {
		return result("not-found", options.runId, signal, [], [], null);
	}
	if (isTerminalStatus(record.status)) {
		return result("already-terminal", options.runId, signal, [], [], record);
	}

	const candidates = runningAttempts(
		record,
		options.attemptId ?? options.taskId,
	);
	const interruptedAttempts: string[] = [];
	const unsupportedAttempts: string[] = [];
	const verifiedTargets = new Map<string, VerifiedInterruptTarget[]>();
	for (const attempt of candidates) {
		const targets = await verifyInterruptTargets(attempt);
		verifiedTargets.set(attempt.attemptId, targets);
		if (await signalVerifiedTargets(targets, signal))
			interruptedAttempts.push(attempt.attemptId);
		else unsupportedAttempts.push(attempt.attemptId);
	}

	// win32: an earlier interrupt (or escalation) may have terminated every
	// process of the attempt before the worker could record a result, since
	// Windows cannot deliver a catchable SIGTERM. Nothing else will then
	// finalize it, so with no live target left and an interrupt already on
	// record, let reconcile mark the attempt cancelled now.
	if (
		process.platform === "win32" &&
		interruptedAttempts.length === 0 &&
		candidates.length > 0 &&
		record.interrupt !== undefined &&
		[...verifiedTargets.values()].every((targets) => targets.length === 0)
	) {
		const reconciled = await reconcileSubagentRun({
			...ref,
			staleAfterMs: 0,
		});
		if (reconciled.record !== null && isTerminalStatus(reconciled.record.status))
			return result(
				"already-terminal",
				options.runId,
				signal,
				[],
				[],
				reconciled.record,
			);
	}

	if (interruptedAttempts.length === 0) {
		await appendRunEvent(ref, {
			type: "run.interrupt_requested",
			status: record.status,
			message: "interrupt unsupported: no interruptable process metadata",
			data: { signal, unsupportedAttempts },
		});
		return result(
			"unsupported",
			options.runId,
			signal,
			interruptedAttempts,
			unsupportedAttempts,
			record,
		);
	}

	const updated = await recordInterruptRequest(
		ref,
		signal,
		options.reason ?? null,
	);
	await appendRunEvent(ref, {
		type: "run.interrupt_requested",
		status: updated.status,
		message: `interrupt requested with ${signal}`,
		data: {
			signal,
			interruptedAttempts,
			unsupportedAttempts,
			reason: options.reason ?? null,
		},
	});

	const termDelay = options.escalateAfterMs ?? 1_000;
	const killDelay = options.killAfterMs ?? 3_000;
	setTimeout(
		() => void escalate(ref, "SIGTERM", verifiedTargets),
		termDelay,
	).unref?.();
	setTimeout(
		() => void escalate(ref, "SIGKILL", verifiedTargets),
		killDelay,
	).unref?.();

	return result(
		"interrupt-requested",
		options.runId,
		signal,
		interruptedAttempts,
		unsupportedAttempts,
		updated,
	);
}
