#!/usr/bin/env node
// Native Windows: replacing a record by rename must survive a reader that
// briefly holds the target open without delete sharing (as antivirus,
// indexers and PowerShell readers do), which makes a plain rename fail.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

if (process.platform !== "win32") {
	console.log("win32 replace-file checks skipped (not Windows)");
	process.exit(0);
}

const jiti = createJiti(import.meta.url);
const { renameReplacing } = await jiti.import("../../src/core/replace-file.ts");
const root = await mkdtemp(join(tmpdir(), "pi-subagent-replace-"));
const target = join(root, "run.json");

// Open the target with FileShare.Read only (no Delete) for holdMs, then exit.
function holdOpen(holdMs) {
	const script = `$f = [System.IO.File]::Open('${target.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${holdMs}; $f.Close()`;
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
	const held = new Promise((resolveHeld, rejectHeld) => {
		child.stdout.on("data", (chunk) => { if (String(chunk).includes("held")) resolveHeld(); });
		child.once("exit", (code) => rejectHeld(new Error(`holder exited early (${code})`)));
	});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	return { held, exited };
}

try {
	await writeFile(target, "old\n");

	// Baseline: a plain rename over the held file fails on Windows.
	let holder = holdOpen(1500);
	await holder.held;
	await writeFile(join(root, "plain.tmp"), "plain\n");
	await assert.rejects(rename(join(root, "plain.tmp"), target), (error) => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
	await holder.exited;

	// renameReplacing waits for the reader to let go and then replaces it.
	holder = holdOpen(700);
	await holder.held;
	await writeFile(join(root, "new.tmp"), "new\n");
	await renameReplacing(join(root, "new.tmp"), target);
	assert.equal(await readFile(target, "utf8"), "new\n");
	await holder.exited;

	// Errors that are not transient sharing violations are not retried.
	await assert.rejects(renameReplacing(join(root, "missing.tmp"), target), (error) => error.code === "ENOENT");

	console.log("win32 replace-file checks passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
