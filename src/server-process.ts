import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerProcessConfig {
	asr?: Record<string, unknown>;
}

export interface ServerProcess {
	asrPort?: number;
	errors: string[];
}

interface ReadyMessage {
	type: "ready";
	asrPort?: number;
	errors?: string[];
}

/** Start the ASR server child with OMP's bundled Bun (`BUN_BE_BUN=1`). */
export async function startServerProcess(config: ServerProcessConfig, logFile: string): Promise<ServerProcess> {
	const script = fileURLToPath(new URL("./server.ts", import.meta.url));
	const child = Bun.spawn({
		cmd: [process.execPath, script],
		cwd: path.dirname(script),
		env: {
			...process.env,
			BUN_BE_BUN: "1",
			OMP_ASR_ZH_SERVER_CONFIG: JSON.stringify(config),
			OMP_ASR_ZH_LOG_FILE: logFile,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	process.once("exit", () => {
		if (child.exitCode === null) child.kill();
	});

	const { promise, resolve, reject } = Promise.withResolvers<ReadyMessage>();
	const timer = setTimeout(() => {
		if (child.exitCode === null) child.kill();
		reject(new Error(`ASR server did not become ready; log: ${logFile}`));
	}, 30_000);
	timer.unref?.();

	void (async () => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const newline = buffer.indexOf("\n");
				if (newline < 0) continue;
				const line = buffer.slice(0, newline).trim();
				if (!line) continue;
				const message = JSON.parse(line) as { type?: unknown };
				if (message.type === "ready") {
					resolve(message as ReadyMessage);
					return;
				}
			}
			const exitCode = await child.exited;
			reject(new Error(`ASR server exited before ready (code ${exitCode}); log: ${logFile}`));
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			clearTimeout(timer);
			reader.releaseLock();
		}
	})();

	const ready = await promise;
	child.unref();
	return {
		asrPort: ready.asrPort,
		errors: ready.errors ?? [],
	};
}
