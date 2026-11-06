import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PROCESS_IDENTITY_TIMEOUT_MS = 2_000;
const DARWIN_PROCESS_IDENTITY_HELPER = fileURLToPath(
	new URL("./native/darwin-process-identity", import.meta.url),
);
/** Cold Windows PowerShell start can exceed the POSIX helper budget. */
const WIN32_PROCESS_IDENTITY_TIMEOUT_MS = 10_000;
const WIN32_MAX_PID = 0xffff_ffff;

export interface ProcessIdentity {
	pid: number;
	processGroupId: number;
	birthIdentity: string;
}

export class ProcessOwnershipError extends Error {
	readonly failureKind = "internal" as const;
	readonly terminalBlocked = true as const;

	constructor(message: string) {
		super(message);
		this.name = "ProcessOwnershipError";
	}
}

export type ProcessIdentityStatus =
	| { state: "alive"; identity: ProcessIdentity }
	| { state: "dead" }
	| { state: "unknown"; reason: string };

export type ProcessGroupStatus = "alive" | "dead" | "unknown";

export function inspectProcessGroup(
	processGroupId: number,
): ProcessGroupStatus {
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
		return "unknown";
	if (process.platform === "win32") return inspectWin32ProcessGroupLeader(processGroupId);
	try {
		process.kill(-processGroupId, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

/**
 * Windows has no POSIX process groups; win32 identities record the pid itself
 * as the group id. Report the liveness of that leader process (signal 0 only
 * tests existence on Windows too). Unlike a POSIX group probe this cannot see
 * orphaned descendants; callers still pair it with the birth-time identity
 * check, and the durable worker waits for its own children before exiting.
 */
function inspectWin32ProcessGroupLeader(pid: number): ProcessGroupStatus {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

async function inspectLinuxProcessIdentity(
	pid: number,
): Promise<ProcessIdentityStatus> {
	try {
		const [stat, bootId] = await Promise.all([
			readFile(`/proc/${pid}/stat`, "utf8"),
			readFile("/proc/sys/kernel/random/boot_id", "utf8"),
		]);
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd < 0)
			return { state: "unknown", reason: "Linux process stat is invalid" };
		const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
		if (fields[0] === "Z" || fields[0] === "X") return { state: "dead" };
		const processGroupId = Number(fields[2]);
		const startTicks = fields[19];
		if (
			!Number.isSafeInteger(processGroupId) ||
			processGroupId <= 0 ||
			startTicks === undefined ||
			!/^\d+$/u.test(startTicks)
		)
			return { state: "unknown", reason: "Linux process identity is invalid" };
		return {
			state: "alive",
			identity: {
				pid,
				processGroupId,
				birthIdentity: `linux:${bootId.trim()}:${startTicks}`,
			},
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ESRCH") return { state: "dead" };
		return {
			state: "unknown",
			reason: `Linux process identity inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function inspectDarwinProcessIdentity(
	pid: number,
): Promise<ProcessIdentityStatus> {
	try {
		const { stdout } = await execFileAsync(
			DARWIN_PROCESS_IDENTITY_HELPER,
			[String(pid)],
			{
				timeout: PROCESS_IDENTITY_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
				env: {
					PATH: "/usr/bin:/bin",
					LC_ALL: "C",
				},
			},
		);
		const parsed = JSON.parse(stdout) as Partial<{
			pid: unknown;
			processGroupId: unknown;
			startSeconds: unknown;
			startMicroseconds: unknown;
		}>;
		const processGroupId = Number(parsed.processGroupId);
		const startSeconds = String(parsed.startSeconds ?? "");
		const startMicroseconds = String(parsed.startMicroseconds ?? "");
		if (
			parsed.pid !== pid ||
			!Number.isSafeInteger(processGroupId) ||
			processGroupId <= 0 ||
			!/^\d+$/u.test(startSeconds) ||
			!/^\d+$/u.test(startMicroseconds) ||
			Number(startMicroseconds) >= 1_000_000
		)
			return {
				state: "unknown",
				reason: "Darwin process identity output is invalid",
			};
		return {
			state: "alive",
			identity: {
				pid,
				processGroupId,
				birthIdentity: `darwin:${startSeconds}:${startMicroseconds.padStart(6, "0")}`,
			},
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (String(code) === "3") return { state: "dead" };
		return {
			state: "unknown",
			reason: `Darwin process identity inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Windows has no /proc and no POSIX process groups. Identity is the pid plus
 * the process creation time (UTC FILETIME ticks, 100 ns since 1601), read via
 * the system PowerShell by absolute path with a minimal environment. Creation
 * time distinguishes a reused pid exactly as Linux start ticks do. Exit code 3
 * means no such process (mirrors the darwin helper). The process group id is
 * the pid itself, which the win32 branches elsewhere already expect.
 */
async function inspectWin32ProcessIdentity(
	pid: number,
): Promise<ProcessIdentityStatus> {
	if (pid > WIN32_MAX_PID)
		return { state: "unknown", reason: "Windows process pid is out of range" };
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
	const powershell = join(
		systemRoot,
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	// pid is a validated positive integer, so interpolating it is not an injection.
	const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 3 }; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`;
	try {
		const { stdout } = await execFileAsync(
			powershell,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
			{
				timeout: WIN32_PROCESS_IDENTITY_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
				windowsHide: true,
				env: { SystemRoot: systemRoot },
			},
		);
		const ticks = stdout.trim();
		if (!/^\d+$/u.test(ticks))
			return { state: "unknown", reason: "Windows process identity output is invalid" };
		return {
			state: "alive",
			identity: { pid, processGroupId: pid, birthIdentity: `win32:${ticks}` },
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (String(code) === "3") return { state: "dead" };
		return {
			state: "unknown",
			reason: `Windows process identity inspection failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
		};
	}
}

/**
 * The same PowerShell lookup as inspectWin32ProcessIdentity, served by one
 * long-lived helper per Node process: starting powershell.exe costs about
 * 0.4 s idle and several seconds under load, which made liveness checks slow
 * enough to delay stop confirmation and widen reconcile races. Requests are
 * answered in order, one `<pid> <ticks>` / `<pid> dead` / `<pid> error ...`
 * line each. The helper reads stdin until EOF, so it ends with its parent,
 * and it is unreferenced while idle so it never keeps the parent alive.
 */
const WIN32_IDENTITY_HELPER_SCRIPT = [
	"while ($null -ne ($line = [Console]::In.ReadLine())) {",
	"  $id = 0",
	"  if (-not [int]::TryParse($line, [ref]$id)) { [Console]::Out.WriteLine(\"$line error invalid pid\"); [Console]::Out.Flush(); continue }",
	// GetProcessById returns the same Process object as Get-Process (so the
	// same StartTime ticks) without cmdlet overhead; ArgumentException means
	// no process with that id is running.
	"  $p = $null; try { $p = [System.Diagnostics.Process]::GetProcessById($id) } catch [System.ArgumentException] { $p = $null }",
	"  if ($null -eq $p) { [Console]::Out.WriteLine(\"$id dead\") }",
	"  else { try { [Console]::Out.WriteLine(\"$id \" + $p.StartTime.ToUniversalTime().Ticks) } catch { [Console]::Out.WriteLine(\"$id error \" + ($_.Exception.Message -replace '\\s+', ' ')) } }",
	"  [Console]::Out.Flush()",
	"}",
].join("\n");

interface Win32IdentityRequest {
	pid: number;
	resolve: (line: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Win32IdentityHelper {
	child: ChildProcessWithoutNullStreams;
	pending: Win32IdentityRequest[];
	buffer: string;
	closed: boolean;
}

let win32IdentityHelper: Win32IdentityHelper | undefined;

function win32PowerShellPath(): { powershell: string; systemRoot: string } {
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
	return {
		systemRoot,
		powershell: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	};
}

function setWin32HelperReferenced(helper: Win32IdentityHelper, referenced: boolean): void {
	for (const handle of [helper.child, helper.child.stdin, helper.child.stdout, helper.child.stderr] as Array<{ ref?: () => void; unref?: () => void }>) {
		if (referenced) handle.ref?.();
		else handle.unref?.();
	}
}

function closeWin32IdentityHelper(helper: Win32IdentityHelper, error: Error): void {
	if (helper.closed) return;
	helper.closed = true;
	if (win32IdentityHelper === helper) win32IdentityHelper = undefined;
	for (const request of helper.pending.splice(0)) {
		clearTimeout(request.timer);
		request.reject(error);
	}
	try {
		helper.child.kill();
	} catch {
		// Already gone.
	}
}

function startWin32IdentityHelper(): Win32IdentityHelper {
	const { powershell, systemRoot } = win32PowerShellPath();
	const encoded = Buffer.from(WIN32_IDENTITY_HELPER_SCRIPT, "utf16le").toString("base64");
	const child = spawn(
		powershell,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { SystemRoot: systemRoot } },
	);
	const helper: Win32IdentityHelper = { child, pending: [], buffer: "", closed: false };
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		helper.buffer += chunk;
		for (;;) {
			const newline = helper.buffer.indexOf("\n");
			if (newline < 0) break;
			const line = helper.buffer.slice(0, newline).trim();
			helper.buffer = helper.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			const request = helper.pending.shift();
			if (request === undefined) continue;
			clearTimeout(request.timer);
			request.resolve(line);
			if (helper.pending.length === 0) setWin32HelperReferenced(helper, false);
		}
	});
	child.stderr.resume();
	child.on("error", (error) => closeWin32IdentityHelper(helper, error));
	child.on("exit", () => closeWin32IdentityHelper(helper, new Error("Windows process identity helper exited")));
	child.stdin.on("error", (error) => closeWin32IdentityHelper(helper, error));
	setWin32HelperReferenced(helper, false);
	return helper;
}

function queryWin32IdentityHelper(pid: number): Promise<string> {
	win32IdentityHelper ??= startWin32IdentityHelper();
	const helper = win32IdentityHelper;
	return new Promise((resolveLine, rejectLine) => {
		const timer = setTimeout(
			() => closeWin32IdentityHelper(helper, new Error("Windows process identity helper timed out")),
			WIN32_PROCESS_IDENTITY_TIMEOUT_MS,
		);
		helper.pending.push({ pid, resolve: resolveLine, reject: rejectLine, timer });
		setWin32HelperReferenced(helper, true);
		helper.child.stdin.write(`${pid}\n`);
	});
}

async function inspectWin32ProcessIdentityFast(
	pid: number,
): Promise<ProcessIdentityStatus> {
	if (pid > WIN32_MAX_PID)
		return { state: "unknown", reason: "Windows process pid is out of range" };
	// ESRCH from signal 0 means no live process has this pid: the same answer
	// the PowerShell lookup gives, without starting PowerShell.
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return { state: "dead" };
	}
	let line: string;
	try {
		line = await queryWin32IdentityHelper(pid);
	} catch {
		// Helper unavailable, crashed or timed out: use the one-shot lookup.
		return await inspectWin32ProcessIdentity(pid);
	}
	const [answeredPid, value, ...rest] = line.split(" ");
	if (answeredPid !== String(pid))
		return { state: "unknown", reason: "Windows process identity helper answered out of order" };
	if (value === "dead") return { state: "dead" };
	if (value !== undefined && /^\d+$/u.test(value) && rest.length === 0)
		return {
			state: "alive",
			identity: { pid, processGroupId: pid, birthIdentity: `win32:${value}` },
		};
	return {
		state: "unknown",
		reason: `Windows process identity inspection failed: ${[value, ...rest].join(" ")}`,
	};
}

export async function inspectProcessIdentity(
	pid: number,
): Promise<ProcessIdentityStatus> {
	if (!Number.isSafeInteger(pid) || pid <= 0)
		return { state: "unknown", reason: "process pid is invalid" };
	if (process.platform === "linux")
		return await inspectLinuxProcessIdentity(pid);
	if (process.platform === "darwin")
		return await inspectDarwinProcessIdentity(pid);
	if (process.platform === "win32")
		return await inspectWin32ProcessIdentityFast(pid);
	return {
		state: "unknown",
		reason: `process identity is unsupported on ${process.platform}`,
	};
}

export async function captureProcessIdentity(
	pid: number,
): Promise<ProcessIdentity> {
	const status = await inspectProcessIdentity(pid);
	if (status.state !== "alive")
		throw new Error(
			status.state === "dead"
				? "process exited before its identity could be recorded"
				: status.reason,
		);
	return status.identity;
}

export async function verifyProcessIdentity(
	expected: ProcessIdentity,
): Promise<"alive" | "dead" | "mismatch" | "unknown"> {
	const status = await inspectProcessIdentity(expected.pid);
	if (status.state === "dead") return "dead";
	if (status.state === "unknown") return "unknown";
	return status.identity.processGroupId === expected.processGroupId &&
		status.identity.birthIdentity === expected.birthIdentity
		? "alive"
		: "mismatch";
}
