import { execFile } from "node:child_process";
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
		return await inspectWin32ProcessIdentity(pid);
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
