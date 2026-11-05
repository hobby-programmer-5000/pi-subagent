#!/usr/bin/env node
// Native Windows stop path. process.kill() ends a process immediately there,
// so a graceful interrupt must stop only the model child and leave the durable
// worker to record the result; the worker is killed only at SIGKILL escalation.
// An attempt whose processes are already gone must still be finalized.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

// Stands in for the durable worker: records that it saw its child exit, then
// exits by itself. With `stubborn` it never exits, to exercise escalation.
function startWorker(childPid, marker, stubborn = false) {
	return startProcess(
		`const fs = require("node:fs");
		const [childPid, marker, stubborn] = process.argv.slice(1);
		const timer = setInterval(() => {
			try { process.kill(Number(childPid), 0); return; } catch {}
			clearInterval(timer);
			fs.writeFileSync(marker, "worker saw child exit");
			if (stubborn === "true") setTimeout(() => {}, 60000);
		}, 20);`,
		String(childPid),
		marker,
		String(stubborn),
	);
}

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
	// A graceful interrupt stops the child only; the worker finishes by itself.
	{
		const child = startSleeper();
		const marker = join(root, "graceful-marker.txt");
		const worker = startWorker(child.child.pid, marker);
		const ref = await createAttempt("graceful", child.child, worker.child);
		const result = await interruptRun({ ...ref, escalateAfterMs: 60_000, killAfterMs: 60_000 });
		assert.equal(result.status, "interrupt-requested");
		assert.deepEqual(result.interruptedAttempts, [ref.attemptId]);
		await waitUntil(() => !pidAlive(child.child.pid), "the model child to stop");
		assert.equal(await worker.exited, 0, "the worker must exit by itself, not be terminated");
		assert.equal(await readFile(marker, "utf8"), "worker saw child exit");
	}

	// SIGTERM escalation still spares the worker; SIGKILL escalation ends it.
	{
		const child = startSleeper();
		const marker = join(root, "stubborn-marker.txt");
		const worker = startWorker(child.child.pid, marker, true);
		const ref = await createAttempt("stubborn", child.child, worker.child);
		const result = await interruptRun({ ...ref, escalateAfterMs: 100, killAfterMs: 1_500 });
		assert.equal(result.status, "interrupt-requested");
		await waitUntil(() => !pidAlive(child.child.pid), "the model child to stop");
		await sleep(600);
		assert.equal(pidAlive(worker.child.pid), true, "SIGTERM escalation must not end the worker");
		assert.equal(await readFile(marker, "utf8"), "worker saw child exit");
		await waitUntil(() => !pidAlive(worker.child.pid), "SIGKILL escalation to end the worker");
	}

	// With no child recorded alive, a graceful interrupt falls back to the worker.
	{
		const child = startSleeper();
		const worker = startSleeper();
		const ref = await createAttempt("worker-only", child.child, worker.child);
		child.child.kill();
		await child.exited;
		const result = await interruptRun({ ...ref, escalateAfterMs: 60_000, killAfterMs: 60_000 });
		assert.equal(result.status, "interrupt-requested");
		await waitUntil(() => !pidAlive(worker.child.pid), "the worker to stop");
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
