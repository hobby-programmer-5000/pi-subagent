// Test-harness helpers for platform differences. POSIX callers get exactly
// the behaviour the checks had before; native Windows gets an equivalent
// fixture or an explicit, stated skip.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const isWin32 = process.platform === "win32";

let symlinkProbe;
/**
 * Whether this process may create symlinks. Always true on POSIX; on Windows
 * it needs Developer Mode or the SeCreateSymbolicLink privilege.
 */
export function canCreateSymlinks() {
	if (!isWin32) return true;
	if (symlinkProbe !== undefined) return symlinkProbe;
	const dir = join(
		process.env.TEMP ?? process.env.TMP ?? ".",
		`pi-subagent-symlink-probe-${process.pid}`,
	);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "target"), "");
		symlinkSync(join(dir, "target"), join(dir, "alias"), "file");
		symlinkProbe = true;
	} catch {
		symlinkProbe = false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return symlinkProbe;
}

export const SYMLINK_SKIP_REASON =
	"win32 cannot create symlinks without Developer Mode or SeCreateSymbolicLink";

/**
 * Link a directory. POSIX and privileged Windows get a real symlink; Windows
 * without symlink rights gets a junction, which Node's lstat also reports as
 * a symbolic link, so link-refusal checks keep their meaning.
 */
export function linkDirectory(target, path) {
	return canCreateSymlinks()
		? symlink(target, path)
		: symlink(target, path, "junction");
}

/**
 * Git for Windows ships `core.autocrlf=true` in its system config, so fixture
 * repositories would check LF files out as CRLF. Pin autocrlf off for every
 * git process this check (and the product code it drives) starts, so fixture
 * bytes stay as written. No-op on POSIX, where the default is already off.
 */
export function pinGitLineEndings() {
	if (!isWin32) return;
	const index = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
	process.env[`GIT_CONFIG_KEY_${index}`] = "core.autocrlf";
	process.env[`GIT_CONFIG_VALUE_${index}`] = "false";
	process.env.GIT_CONFIG_COUNT = String(index + 1);
}

/** Print one stated skip line in the style the checks already use. */
export function logSkip(what, reason) {
	console.log(`${what} skipped: ${reason}`);
}

/**
 * A long-lived child process for identity and signal checks:
 * `/bin/sleep 30` on POSIX, an idle Node process on Windows.
 */
export function sleeperCommand(seconds = 30) {
	if (!isWin32) return ["/bin/sleep", [String(seconds)]];
	return [
		process.execPath,
		["-e", `setTimeout(() => {}, ${Number(seconds) * 1000})`],
	];
}

/** PATH with `dir` first, using the platform's PATH delimiter. */
export function prependPath(dir, path = process.env.PATH) {
	return isWin32 ? `${dir}${delimiter}${path ?? ""}` : `${dir}:${path ?? ""}`;
}

/**
 * Windows cannot remove a directory while a just-exited child still holds a
 * handle in it (EBUSY/EPERM/ENOTEMPTY for a moment). Retry there; POSIX keeps
 * the single attempt.
 */
export function rmTree(path, options = {}) {
	return rm(path, {
		recursive: true,
		force: true,
		...(isWin32 ? { maxRetries: 20, retryDelay: 100 } : {}),
		...options,
	});
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_ROOT_ENV = "PI_SUBAGENT_PI_PACKAGE_ROOT";

/**
 * On Windows the default `pi` command is launched as `node <pi package CLI>`
 * from the package that PI_SUBAGENT_PI_PACKAGE_ROOT (or the install layout)
 * names, so a fake `pi` script on PATH is never used. Build a minimal package
 * root whose CLI entry is `script` and point the env var at it. Returns a
 * function that restores the previous value. On POSIX this is a no-op.
 */
export function useFakePiPackage(script, rootDir) {
	if (!isWin32) return () => {};
	const previous = process.env[PI_PACKAGE_ROOT_ENV];
	process.env[PI_PACKAGE_ROOT_ENV] = writeFakePiPackage(script, rootDir);
	return () => {
		if (previous === undefined) delete process.env[PI_PACKAGE_ROOT_ENV];
		else process.env[PI_PACKAGE_ROOT_ENV] = previous;
	};
}

function writeFakePiPackage(script, rootDir) {
	const root = join(rootDir, "node_modules", ...PI_PACKAGE.split("/"));
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: PI_PACKAGE, type: "module", bin: { pi: "cli.mjs" } }),
	);
	writeFileSync(
		join(root, "cli.mjs"),
		`await import(${JSON.stringify(pathToFileURL(script).href)});\n`,
	);
	return root;
}

const fakePiRoots = new Map();
/**
 * Runner options that launch `script` as the Pi CLI. POSIX passes it as
 * `piCommand`, as the checks always did. Windows cannot spawn a script
 * without a shell, and an explicit piCommand is spawned as given, so there
 * the default `pi` launch is pointed at a fake package for `script` instead.
 * Call it right before each run; the last call wins for later default runs.
 */
export function fakePiOptions(script) {
	if (!isWin32) return { piCommand: script };
	let root = fakePiRoots.get(script);
	if (root === undefined) {
		root = writeFakePiPackage(
			script,
			join(dirname(script), `fake-pi-package-${basename(script)}`),
		);
		fakePiRoots.set(script, root);
	}
	process.env[PI_PACKAGE_ROOT_ENV] = root;
	return {};
}
