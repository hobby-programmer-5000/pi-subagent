import { rename } from "node:fs/promises";

const WIN32_REPLACE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_REPLACE_RETRY_LIMIT = 40;

/**
 * Replace `to` with `from` by rename. Windows refuses to rename over a file
 * that another process has open (EPERM/EACCES/EBUSY), and run records and
 * results are polled by the host, supervisors, finalizers and workers at
 * the same time. Those readers hold the file only briefly, so on win32 the
 * replace is retried with a short backoff (about 8 s in total, like
 * graceful-fs). POSIX renames are unchanged.
 */
export async function renameReplacing(from: string, to: string): Promise<void> {
	if (process.platform !== "win32") {
		await rename(from, to);
		return;
	}
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (!WIN32_REPLACE_RETRY_CODES.has(code ?? "") || attempt >= WIN32_REPLACE_RETRY_LIMIT)
				throw error;
		}
		await new Promise((resolveSleep) =>
			setTimeout(resolveSleep, Math.min(25 * (attempt + 1), 250)),
		);
	}
}
