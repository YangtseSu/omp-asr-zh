import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { defaultModelDir } from "./model";
import { getConfigPath } from "./paths";

export const ASR_PROVIDER = "omp-asr-zh";
export const ASR_MODEL_ID = "x-asr-960ms-zh-en";
export const ASR_MODEL_SELECTOR = `${ASR_PROVIDER}/${ASR_MODEL_ID}`;

export interface LiveConfig {
	enabled: boolean;
	/** Key chord registered with OMP; takes effect on the next session. */
	shortcut: string;
	/** Command that writes raw 16 kHz mono s16le PCM to stdout, or "auto". */
	capture: string;
}

export interface AsrZhConfig {
	asr: {
		enabled: boolean;
		modelDir: string;
		modelType: string;
		numThreads: number;
		tailPaddingSeconds: number;
	};
	live: LiveConfig;
	autoSelectRoles: boolean;
}

function expandHome(value: string): string {
	const expanded = value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
	return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function readConfigFile(): Record<string, unknown> {
	const file = getConfigPath();
	if (!existsSync(file)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function findAsrModelDir(configured: unknown): string {
	const envDir = process.env.OMP_ASR_ZH_MODEL_DIR;
	if (envDir) return expandHome(envDir);
	if (typeof configured === "string" && configured.trim()) return expandHome(configured);
	return defaultModelDir();
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return !["0", "false", "no", "off"].includes(value.toLowerCase());
	return fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

export function loadConfig(): AsrZhConfig {
	const raw = readConfigFile();
	const asr = asRecord(raw.asr);
	const live = asRecord(raw.live);
	const configuredModelType = process.env.OMP_ASR_ZH_MODEL_TYPE ?? asr.modelType;
	const configuredCapture = process.env.OMP_ASR_ZH_CAPTURE ?? live.capture;
	const configuredShortcut = process.env.OMP_ASR_ZH_SHORTCUT ?? live.shortcut;
	return {
		asr: {
			enabled: asBool(process.env.OMP_ASR_ZH_ENABLED ?? asr.enabled, true),
			modelDir: findAsrModelDir(asr.modelDir),
			modelType: typeof configuredModelType === "string" && configuredModelType.trim() ? configuredModelType : "zipformer2",
			numThreads: Math.round(asNumber(process.env.OMP_ASR_ZH_THREADS ?? asr.numThreads, 2, 1, 8)),
			tailPaddingSeconds: asNumber(asr.tailPaddingSeconds, 1.5, 0, 5),
		},
		live: {
			enabled: asBool(process.env.OMP_ASR_ZH_LIVE_ENABLED ?? live.enabled, true),
			shortcut:
				typeof configuredShortcut === "string" && configuredShortcut.trim()
					? configuredShortcut.trim()
					: "ctrl+alt+space",
			capture:
				typeof configuredCapture === "string" && configuredCapture.trim() ? configuredCapture.trim() : "auto",
		},
		autoSelectRoles: asBool(process.env.OMP_ASR_ZH_AUTOSELECT ?? raw.autoSelectRoles, true),
	};
}

export function saveLiveSettings(update: Partial<LiveConfig>): AsrZhConfig {
	const file = getConfigPath();
	const raw = readConfigFile();
	const live = asRecord(raw.live);
	if (update.enabled !== undefined) live.enabled = update.enabled;
	if (update.shortcut !== undefined) live.shortcut = update.shortcut;
	if (update.capture !== undefined) live.capture = update.capture;
	raw.live = live;
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	return loadConfig();
}
