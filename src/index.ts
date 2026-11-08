import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { KeyId } from "@oh-my-pi/pi-tui/app-keybindings";

import {
	ASR_MODEL_ID,
	ASR_PROVIDER,
	type AsrZhConfig,
	loadConfig,
	saveLiveSettings,
} from "./config";
import { LiveDictation, type LiveState } from "./live-dictation";
import { ensureModel, isModelReady } from "./model";
import { getConfigPath, getLogFile } from "./paths";
import { type ServerProcess, startServerProcess } from "./server-process";

const SERVER_TOKEN = crypto.randomUUID();
const LOG_FILE = getLogFile();

interface Servers {
	process?: ServerProcess;
}

let config: AsrZhConfig;
let servers: Servers = {};
let serversReady: Promise<void> | undefined;
let live: LiveDictation | undefined;
let liveState: LiveState = "idle";
type ModelState = "checking" | "ready" | "downloading" | "error";
let modelState: ModelState = "checking";
let modelPercent = 0;
let modelError: string | undefined;
let modelTask: Promise<void> | undefined;
const startupErrors: string[] = [];

function log(
	pi: ExtensionAPI,
	level: "debug" | "info" | "warn" | "error",
	message: string,
	details?: Record<string, unknown>,
): void {
	if (details === undefined) pi.logger[level](message);
	else pi.logger[level](message, details);
}

function resolveSherpaRuntime(): string {
	const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const candidates = [
		path.join(extensionRoot, "node_modules", "sherpa-onnx-node", "sherpa-onnx.js"),
		// Published plugins may hoist dependencies beside the package.
		path.join(path.dirname(extensionRoot), "sherpa-onnx-node", "sherpa-onnx.js"),
		path.join(path.dirname(extensionRoot), "node_modules", "sherpa-onnx-node", "sherpa-onnx.js"),
	];
	for (const entry of candidates) {
		if (existsSync(entry)) return entry;
	}
	try {
		return createRequire(path.join(extensionRoot, "package.json")).resolve("sherpa-onnx-node");
	} catch {
		throw new Error("sherpa-onnx-node is not installed; run bun install");
	}
}

async function startServer(pi: ExtensionAPI): Promise<void> {
	mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	const runtimeEntry = config.asr.enabled ? resolveSherpaRuntime() : undefined;
	const asr =
		config.asr.enabled && runtimeEntry
			? {
					runtimeEntry,
					modelDir: config.asr.modelDir,
					modelType: config.asr.modelType,
					numThreads: config.asr.numThreads,
					tailPaddingSeconds: config.asr.tailPaddingSeconds,
					token: SERVER_TOKEN,
				}
			: undefined;
	try {
		servers.process = await startServerProcess({ asr }, LOG_FILE);
		startupErrors.push(...servers.process.errors);
		log(pi, "info", "ASR server ready", {
			asrPort: servers.process.asrPort,
			logFile: LOG_FILE,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		startupErrors.push(`server: ${message}`);
		log(pi, "error", "ASR server unavailable", { error: message, logFile: LOG_FILE });
	}
}

async function ensureModelForUse(pi: ExtensionAPI): Promise<void> {
	if (!config.asr.enabled) {
		modelState = "ready";
		return;
	}
	if (modelState === "ready") return;
	if (modelState === "error") {
		modelError = undefined;
		modelState = "checking";
		modelTask = undefined;
	}
	modelTask ??= (async () => {
		try {
			if (await isModelReady(config.asr.modelDir)) {
				modelState = "ready";
				modelPercent = 100;
				return;
			}
			modelState = "downloading";
			let lastBucket = -1;
			await ensureModel(config.asr.modelDir, {
				onProgress: progress => {
					if (progress.phase === "download") {
						modelPercent = Math.floor((progress.loaded / Math.max(1, progress.total)) * 100);
						const bucket = Math.floor(modelPercent / 10);
						if (bucket !== lastBucket) {
							lastBucket = bucket;
							log(pi, "info", "downloading X-ASR model", { percent: modelPercent });
						}
					} else if (progress.phase === "extract") {
						modelPercent = 100;
						log(pi, "info", "extracting X-ASR model", { modelDir: config.asr.modelDir });
					}
				},
			});
			modelState = "ready";
			modelPercent = 100;
			log(pi, "info", "X-ASR model ready", { modelDir: config.asr.modelDir });
		} catch (error) {
			modelState = "error";
			modelError = error instanceof Error ? error.message : String(error);
			log(pi, "error", "X-ASR model unavailable", { error: modelError, modelDir: config.asr.modelDir });
		}
	})();
	await modelTask;
}

function registerProvider(pi: ExtensionAPI, port: number): void {
	pi.registerProvider(ASR_PROVIDER, {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: SERVER_TOKEN,
		api: "openai-transcriptions",
		models: [
			{
				id: ASR_MODEL_ID,
				name: "X-ASR 960ms streaming (zh-en, int8)",
				api: "openai-transcriptions",
				kind: "stt",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		],
	});
}



function report(ctx: ExtensionCommandContext, text: string): void {
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else process.stdout.write(`${text}\n`);
}

function findSelftestWav(): string {
	const configured = process.env.OMP_ASR_ZH_SELFTEST_WAV;
	if (configured) return configured;
	const dir = path.join(config.asr.modelDir, "test_wavs");
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter(file => file.endsWith(".wav"))
			.sort();
	} catch {
		throw new Error(`No selftest WAV under ${dir}; set OMP_ASR_ZH_SELFTEST_WAV`);
	}
	const first = files[0];
	if (!first) throw new Error(`No selftest WAV under ${dir}; set OMP_ASR_ZH_SELFTEST_WAV`);
	return path.join(dir, first);
}

async function runSelftest(): Promise<string> {
	const port = servers.process?.asrPort;
	if (!port) throw new Error("ASR server is unavailable");
	const audio = readFileSync(findSelftestWav());
	const form = new FormData();
	form.append("file", new Blob([audio], { type: "audio/wav" }), "selftest.wav");
	const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${SERVER_TOKEN}` },
		body: form,
	});
	if (!response.ok) {
		throw new Error(`ASR selftest failed (${response.status}): ${await response.text()}`);
	}
	const result = (await response.json()) as { text?: string };
	const text = result.text?.trim();
	if (!text) throw new Error("ASR returned an empty transcript");
	return `ASR ${audio.byteLength} bytes -> ${text}`;
}

function statusText(): string {
	const asrPort = servers.process?.asrPort;
	const lines = [
		`ASR: ${asrPort ? `127.0.0.1:${asrPort}` : "unavailable"}  ${config.asr.modelDir}`,
		`model: ${modelState}${modelState === "downloading" ? ` ${modelPercent}%` : ""}${modelError ? ` (${modelError})` : ""}`,
		`live: ${config.live.enabled ? "on" : "off"}  shortcut=${config.live.shortcut}  capture=${config.live.capture}  state=${live?.state ?? liveState}`,
		`config: ${getConfigPath()}`,
	];
	if (startupErrors.length > 0) lines.push(`errors: ${startupErrors.join("; ")}`);
	return lines.join("\n");
}

function liveDictation(pi: ExtensionAPI): LiveDictation | undefined {
	const port = servers.process?.asrPort;
	if (!config.asr.enabled || !port) return undefined;
	live ??= new LiveDictation({
		port,
		token: SERVER_TOKEN,
		capture: config.live.capture,
		onError: error => {
			log(pi, "error", "live dictation failed", { error: error.message });
		},
		onStateChange: state => {
			liveState = state;
		},
	});
	return live;
}

function resetLive(): void {
	live?.dispose();
	live = undefined;
	liveState = "idle";
}

export default async function asrZh(pi: ExtensionAPI): Promise<void> {
	config = loadConfig();
	if (!config.asr.enabled) {
		modelState = "ready";
		modelPercent = 100;
	}

	try {
		pi.registerShortcut(config.live.shortcut as KeyId, {
			description: "Chinese ASR: toggle live dictation",
			handler: async ctx => {
				if (!config.live.enabled) {
					ctx.ui.notify("Live dictation is disabled", "warning");
					return;
				}
				if (modelState !== "ready") {
					if (await isModelReady(config.asr.modelDir)) {
						modelState = "ready";
						modelPercent = 100;
					} else {
						void ensureModelForUse(pi);
						ctx.ui.notify(
							modelState === "error"
								? `X-ASR model unavailable: ${modelError}`
								: "X-ASR model is downloading; try again when ready",
							modelState === "error" ? "error" : "warning",
						);
						return;
					}
				}
				const dictation = liveDictation(pi);
				if (!dictation) {
					ctx.ui.notify("ASR server is unavailable", "error");
					return;
				}
				await dictation.toggle(ctx);
			},
		});
	} catch (error) {
		log(pi, "warn", "live dictation shortcut unavailable", {
			shortcut: config.live.shortcut,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	serversReady ??= startServer(pi);
	await serversReady;
	if (servers.process?.asrPort) registerProvider(pi, servers.process.asrPort);
	if (config.asr.enabled && servers.process?.asrPort) void ensureModelForUse(pi);

	pi.on("session_start", async () => {
		if (!config.live.enabled) return;
		try {
			const conflict = pi.getShortcutConflict(config.live.shortcut as KeyId);
			if (conflict) {
				log(pi, "warn", "live dictation shortcut conflict", {
					shortcut: config.live.shortcut,
					kind: conflict.kind,
				});
			}
		} catch {
			// The shortcut check is advisory; a blocked key is reported by the TUI.
		}
	});
	pi.on("session_shutdown", async () => {
		resetLive();
	});

	pi.registerCommand("asr-zh", {
		description: "Chinese ASR: status, selftest, live, shortcut, capture",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			try {
				switch (subcommand || "status") {
					case "status":
						report(ctx, statusText());
						return;
					case "selftest": {
						report(ctx, "preparing ASR model...");
						await ensureModelForUse(pi);
						if (modelState === "error") throw new Error(modelError ?? "X-ASR model unavailable");
						const result = await runSelftest();
						report(ctx, result);
						return;
					}
					case "live": {
						const action = rest[0];
						if (action === "on" || action === "off") {
							config = saveLiveSettings({ enabled: action === "on" });
							if (action === "off") resetLive();
							report(ctx, `live dictation ${action === "on" ? "enabled" : "disabled"}`);
							return;
						}
						if (!ctx.hasUI) {
							report(ctx, "live dictation needs the interactive TUI; use the configured shortcut");
							return;
						}
						const dictation = liveDictation(pi);
						if (!dictation) {
							report(ctx, "ASR server is unavailable");
							return;
						}
						await dictation.toggle(ctx);
						return;
					}
					case "shortcut": {
						const shortcut = rest[0]?.trim();
						if (!shortcut) {
							report(ctx, `usage: /asr-zh shortcut <key>\ncurrent: ${config.live.shortcut}`);
							return;
						}
						config = saveLiveSettings({ shortcut });
						report(ctx, `live shortcut saved: ${config.live.shortcut} (restart OMP to bind it)`);
						return;
					}
					case "capture": {
						const command = rest.join(" ").trim();
						if (!command) {
							report(ctx, `usage: /asr-zh capture <command|auto>\ncurrent: ${config.live.capture}`);
							return;
						}
						config = saveLiveSettings({ capture: command });
						resetLive();
						report(ctx, `capture command saved: ${config.live.capture}`);
						return;
					}
					default:
						report(
							ctx,
							"usage: /asr-zh [status|selftest|live [on|off]|shortcut <key>|capture <command|auto>]",
						);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(pi, "error", "asr-zh command failed", { error: message });
				report(ctx, `error: ${message}`);
			}
		},
	});
}
