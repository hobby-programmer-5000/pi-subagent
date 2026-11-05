#!/usr/bin/env node
// Native Windows process identity: the persistent PowerShell helper must
// report the same birth identity as a direct PowerShell lookup, answer
// concurrent requests in order, detect dead processes, be fast once warm,
// and never keep its parent process alive.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createJiti } from "jiti";

if (process.platform !== "win32") {
	console.log("win32 process identity checks skipped (not Windows)");
	process.exit(0);
}

const jiti = createJiti(import.meta.url);
const identity = await jiti.import("../../src/process-identity.ts");

function directTicks(pid) {
	return execFileSync(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks)`],
		{ encoding: "utf8", windowsHide: true },
	).trim();
}

// Same identity string as a direct lookup (records written by either path match).
const self = await identity.inspectProcessIdentity(process.pid);
assert.equal(self.state, "alive");
assert.equal(self.identity.birthIdentity, `win32:${directTicks(process.pid)}`);
assert.equal(self.identity.processGroupId, process.pid);

// A live child is alive with a stable identity; after it exits it is dead.
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
await new Promise((resolveSpawn) => child.once("spawn", resolveSpawn));
const childIdentity = await identity.captureProcessIdentity(child.pid);
assert.equal(childIdentity.birthIdentity, `win32:${directTicks(child.pid)}`);
assert.equal(await identity.verifyProcessIdentity(childIdentity), "alive");
assert.equal(
	await identity.verifyProcessIdentity({ ...childIdentity, birthIdentity: "win32:1" }),
	"mismatch",
);
child.kill();
await new Promise((resolveExit) => child.once("exit", resolveExit));
assert.equal(await identity.verifyProcessIdentity(childIdentity), "dead");
assert.equal((await identity.inspectProcessIdentity(4_294_960)).state, "dead");

// Concurrent requests are answered per pid.
const pids = [process.pid, 4_294_960, process.pid, 4_294_952, process.pid];
const results = await Promise.all(pids.map((pid) => identity.inspectProcessIdentity(pid)));
assert.deepEqual(results.map((result) => result.state), ["alive", "dead", "alive", "dead", "alive"]);
for (const result of results.filter((entry) => entry.state === "alive"))
	assert.equal(result.identity.birthIdentity, self.identity.birthIdentity);

// Warm lookups are fast (each one used to start powershell.exe).
const started = performance.now();
for (let index = 0; index < 50; index += 1) {
	const result = await identity.inspectProcessIdentity(process.pid);
	assert.equal(result.state, "alive");
}
const perLookupMs = (performance.now() - started) / 50;
assert.ok(perLookupMs < 100, `warm lookup took ${perLookupMs.toFixed(1)} ms`);

// The helper never keeps its parent alive: a script that performs one lookup
// and then has nothing left to do must exit promptly on its own.
const exitStarted = Date.now();
const probe = spawn(
	process.execPath,
	[
		"--input-type=module",
		"-e",
		`import { createJiti } from "jiti"; const j = createJiti(${JSON.stringify(import.meta.url)}); const m = await j.import("../../src/process-identity.ts"); const r = await m.inspectProcessIdentity(process.pid); console.log(r.state);`,
	],
	{ cwd: new URL("../..", import.meta.url), stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
);
let probeOut = "";
probe.stdout.on("data", (chunk) => { probeOut += chunk; });
const probeCode = await new Promise((resolveExit, rejectExit) => {
	const timer = setTimeout(() => { probe.kill(); rejectExit(new Error("probe process did not exit within 20 s")); }, 20_000);
	probe.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
});
assert.equal(probeCode, 0);
assert.equal(probeOut.trim(), "alive");

console.log(`win32 process identity checks passed (warm lookup ${perLookupMs.toFixed(1)} ms, probe exit ${Date.now() - exitStarted} ms)`);
