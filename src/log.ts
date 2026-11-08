import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const logFile = process.env.OMP_ASR_ZH_LOG_FILE;

/** Child-process log sink; the parent extension keeps its own omp logger. */
export function log(level: LogLevel, message: string, details?: unknown): void {
	if (!logFile) return;
	try {
		appendFileSync(
			logFile,
			`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...(details ? { details } : {}) })}\n`,
		);
	} catch {
		// Logging must never break an ASR request.
	}
}
