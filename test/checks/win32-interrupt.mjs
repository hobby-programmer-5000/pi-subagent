#!/usr/bin/env node
// Native Windows stop path. process.kill() ends a process immediately there,
// so a graceful interrupt of an attempt with a live durable worker signals
// nothing: it records the request, and the worker cancels itself and records
// the result. SIGKILL escalation ends every process and finalizes the attempt.
// An attempt whose processes are already gone must still be finalized.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

if (process.platform !== "win32") {
	console.log("win32 interrupt checks skipped (not Windows)");
	process.exit(0);
}

const jiti = createJiti(import.meta.url);
const artifacts = await jiti.import("../../src/artifacts/index.ts");
const { interruptRun } = await jiti.import("../../src/orchestrate/interrupt.ts");
const { captureProcessIdentity } = await jiti.import("../../src/process-identity.ts");

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const root = await mkdtemp(join(tmpdir(), "pi-subagent-interrupt-"));
process.env.PI_SUBAGENT_RUN_INDEX_DIR = join(root, "run-index");
const spawned = [];

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(condition, label, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function startProcess(source, ...args) {
	const child = spawn(process.execPath, ["-e", source, ...args], { stdio: "ignore", windowsHide: true });
	spawned.push(child);
	const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
	return { child, exited };
}

const startSleeper = () => startProcess("setTimeout(() => {}, 60000)");

async function createAttempt(name, child, worker) {
	const cwd = join(root, name);
	const runId = `run_${name}`;
	const attemptId = `attempt_${name}`;
	const startedAt = new Date();
	const store = await artifacts.createAttemptArtifactStore({ cwd, runId, attemptId });
	const result = await store.writeResult({
		backend: "headless",
		status: "running",
		failureKind: null,
		cwd,
		startedAt,
		completedAt: null,
		workspace: { mode: "shared", cwd, worktreePath: null },
		sandbox: { enabled: false },
		exitCode: null,
		signal: null,
		artifacts: [],
		metadata: { contextLengthExceeded: false },
	});
	const childIdentity = await captureProcessIdentity(child.pid);
	const workerIdentity = await captureProcessIdentity(worker.pid);
	await artifacts.beginRunRecord({
		cwd,
		runId,
		mode: "single",
		backend: "headless",
		startedAt,
		activeAttemptId: attemptId,
		attempts: [
			{
				attemptId,
				status: "running",
				backend: "headless",
				startedAt,
				artifactCwd: cwd,
				resultPath: result.artifacts.find((artifact) => artifact.type === "result")?.path,
				process: {
					command: process.execPath,
					pid: childIdentity.pid,
					processGroupId: childIdentity.processGroupId,
					processBirthIdentity: childIdentity.birthIdentity,
					workerPid: workerIdentity.pid,
					workerProcessGroupId: workerIdentity.processGroupId,
					workerProcessBirthIdentity: workerIdentity.birthIdentity,
				},
			},
		],
	});
	return { cwd, runId, attemptId };
}

try {
	// A graceful interrupt with a live worker signals nothing: it records the
	// request, which the durable worker watches for and acts on itself.
	{
		const child = startSleeper();
		const worker = startSleeper();
		const ref = await createAttempt("graceful", child.child, worker.child);
		const result = await interruptRun({ ...ref, escalateAfterMs: 60_000, killAfterMs: 60_000 });
		assert.equal(result.status, "interrupt-requested");
		assert.deepEqual(result.interruptedAttempts, [ref.attemptId]);
		assert.equal(result.record?.interrupt?.signal, "SIGTERM");
		await sleep(500);
		assert.equal(pidAlive(child.child.pid), true, "a graceful request must not terminate the model child");
		assert.equal(pidAlive(worker.child.pid), true, "a graceful request must not terminate the worker");
	}

	// SIGTERM escalation still signals nothing; SIGKILL escalation ends every
	// process of a worker that did not act, and the attempt ends cancelled.
	{
		const child = startSleeper();
		const worker = startSleeper();
		const ref = await createAttempt("stubborn", child.child, worker.child);
		const result = await interruptRun({ ...ref, escalateAfterMs: 100, killAfterMs: 1_500 });
		assert.equal(result.status, "interrupt-requested");
		await sleep(600);
		assert.equal(pidAlive(child.child.pid), true, "SIGTERM escalation must not terminate the model child");
		assert.equal(pidAlive(worker.child.pid), true, "SIGTERM escalation must not terminate the worker");
		await waitUntil(
			() => !pidAlive(child.child.pid) && !pidAlive(worker.child.pid),
			"SIGKILL escalation to end the child and the worker",
		);
		await waitUntil(
			async () => (await artifacts.readRunRecord(ref))?.status === "cancelled",
			"the killed attempt to be finalized as cancelled",
		);
		const record = await artifacts.readRunRecord(ref);
		assert.equal(record?.attempts[0]?.status, "cancelled");
		assert.equal(record?.failureKind, "user_cancelled");
	}

	// Without a live worker, a graceful interrupt stops only the model child.
	{
		const child = startSleeper();
		const worker = startSleeper();
		const ref = await createAttempt("child-only", child.child, worker.child);
		worker.child.kill();
		await worker.exited;
		const result = await interruptRun({ ...ref, escalateAfterMs: 60_000, killAfterMs: 60_000 });
		assert.equal(result.status, "interrupt-requested");
		await waitUntil(() => !pidAlive(child.child.pid), "the model child to stop");
	}

	// Every process gone after an interrupt: the attempt is finalized as cancelled.
	{
		const child = startSleeper();
		const worker = startSleeper();
		const ref = await createAttempt("all-gone", child.child, worker.child);
		await artifacts.recordInterruptRequest(ref, "SIGTERM", "test");
		child.child.kill();
		worker.child.kill();
		await Promise.all([child.exited, worker.exited]);
		const result = await interruptRun({ ...ref, escalateAfterMs: 60_000, killAfterMs: 60_000 });
		assert.equal(result.status, "already-terminal");
		assert.equal(result.record?.status, "cancelled");
		assert.equal(result.record?.attempts[0]?.status, "cancelled");
		assert.equal(result.record?.failureKind, "user_cancelled");
	}

	// Without an earlier interrupt, dead processes are not silently cancelled here.
	{
		const child = startSleeper();
		const worker = startSleeper();
		const ref = await createAttempt("no-interrupt", child.child, worker.child);
		child.child.kill();
		worker.child.kill();
		await Promise.all([child.exited, worker.exited]);
		const result = await interruptRun({ ...ref, escalateAfterMs: 60_000, killAfterMs: 60_000 });
		assert.equal(result.status, "unsupported");
		assert.equal(result.record?.status, "running");
	}

	console.log("win32 interrupt checks passed");
} finally {
	for (const child of spawned) {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	}
	await sleep(100);
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
