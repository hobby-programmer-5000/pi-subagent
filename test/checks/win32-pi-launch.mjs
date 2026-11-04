#!/usr/bin/env node
// Native Windows: the default `pi` command must resolve to `node <pi cli>`
// even outside a Pi host (for example a standalone workflow supervisor),
// where process.argv has no Pi entry and no package root is inherited.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createJiti } from "jiti";

if (process.platform !== "win32") {
	console.log("win32 pi launch checks skipped (not Windows)");
	process.exit(0);
}

delete process.env.PI_SUBAGENT_PI_PACKAGE_ROOT;
const jiti = createJiti(import.meta.url);
const { resolveLaunchablePiArgv } = await jiti.import("../../src/runners/headless-model.ts");

const argv = resolveLaunchablePiArgv(["pi", "--version"], undefined);
assert.equal(argv[0], process.execPath);
assert.match(argv[1], /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]/u);
assert.ok(existsSync(argv[1]), `pi CLI entry ${argv[1]} must exist`);
assert.deepEqual(argv.slice(2), ["--version"]);

// An explicit piCommand and non-default commands are left to the caller.
assert.deepEqual(resolveLaunchablePiArgv(["pi", "-p"], "custom-pi"), ["pi", "-p"]);
assert.deepEqual(resolveLaunchablePiArgv(["other", "-p"], undefined), ["other", "-p"]);

console.log("win32 pi launch checks passed");
