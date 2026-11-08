import { homedir } from "node:os";
import * as path from "node:path";

/** OMP agent directory, honoring the profile/agent-dir override. */
export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".omp", "agent");
}

/** Shared OMP speech-model cache. */
export function getTinyModelsCacheDir(): string {
	return path.join(getAgentDir(), "cache", "tiny-models");
}

export function getConfigPath(): string {
	return process.env.OMP_ASR_ZH_CONFIG || path.join(getAgentDir(), "omp-asr-zh.json");
}

export function getLogFile(): string {
	return path.join(getAgentDir(), "cache", "omp-asr-zh", "server.log");
}
