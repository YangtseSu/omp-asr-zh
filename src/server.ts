import { startAsrServer, type AsrServerConfig } from "./asr-server";
import { log } from "./log";

interface ServerConfig {
	asr?: AsrServerConfig;
}

const raw = process.env.OMP_ASR_ZH_SERVER_CONFIG;
if (!raw) {
	process.stderr.write("OMP_ASR_ZH_SERVER_CONFIG is not set\n");
	process.exit(2);
}

const config = JSON.parse(raw) as ServerConfig;
const errors: string[] = [];
let asrPort: number | undefined;

try {
	if (config.asr) asrPort = startAsrServer(config.asr).port;
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	errors.push(`ASR: ${message}`);
	log("error", "ASR server failed", { error: message });
}

process.stdout.write(`${JSON.stringify({ type: "ready", asrPort, errors })}\n`);
process.stdout.end();

process.on("uncaughtException", error => {
	log("error", "uncaught exception", { error: error.message, stack: error.stack });
});
process.on("unhandledRejection", error => {
	log("error", "unhandled rejection", { error: error instanceof Error ? error.message : String(error) });
});

const parentPid = process.ppid;
setInterval(() => {
	if (process.ppid !== parentPid) process.exit(0);
}, 5_000).unref();
