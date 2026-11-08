import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import type { Model } from "@oh-my-pi/pi-ai";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ensureRuntimeInstalled, getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";

import {
	ASR_MODEL_ID,
	ASR_MODEL_SELECTOR,
	ASR_PROVIDER,
	type AsrZhConfig,
	getConfigPath,
	getLogFile,
	loadConfig,
	saveLiveSettings,
} from "./config";
import { LiveDictation, type LiveState } from "./live-dictation";
import { type ServerProcess, startServerProcess } from "./server-process";

const SHERPA_VERSION = "1.13.2";
const BUILTIN_DICTATION: Record<string, true> = {
	"local/parakeet-tdt-0.6b-v3": true,
	"local/nemotron-streaming-en-0.6b": true,
	"local/whisper-base": true,
	"local/whisper-small": true,
	"local/whisper-large-v3-turbo": true,
	// The native X-ASR tier from the unmerged upstream PR. The extension serves
	// the same model, so taking over the role keeps live dictation working on a
	// stock release.
	"local/x-asr-960ms-zh-en": true,
};
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
const startupErrors: string[] = [];

function log(pi: ExtensionAPI, level: "debug" | "info" | "warn" | "error", message: string, details?: unknown): void {
	if (details === undefined) pi.logger[level](message);
	else pi.logger[level](message, details);
}

async function resolveSherpaRuntime(pi: ExtensionAPI): Promise<string> {
	const runtimeDir = path.join(path.dirname(getTinyModelsCacheDir()), "stt-runtime", `sherpa-${SHERPA_VERSION}`);
	const entry = path.join(runtimeDir, "node_modules", "sherpa-onnx-node", "sherpa-onnx.js");
	if (existsSync(entry)) return entry;
	log(pi, "info", "installing sherpa-onnx runtime", { runtimeDir, version: SHERPA_VERSION });
	await ensureRuntimeInstalled({
		runtimeDir,
		install: { dependencies: { "sherpa-onnx-node": SHERPA_VERSION } },
		probePackage: "sherpa-onnx-node",
		onPhase: phase => log(pi, "debug", "sherpa runtime install", { phase }),
	});
	if (!existsSync(entry)) throw new Error(`sherpa-onnx runtime entry not found at ${entry}`);
	return entry;
}

async function startServer(pi: ExtensionAPI): Promise<void> {
	mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	const runtimeEntry = config.asr.enabled ? await resolveSherpaRuntime(pi) : undefined;
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

function setRole(settings: Settings, force: boolean): string[] {
	const handle = lookup("modelRoles");
	if (!handle) return [];
	if (!config.asr.enabled || !servers.process?.asrPort) return [];
	const current = (handle.get(settings) ?? {}) as Record<string, string>;
	const replace = force || !current.dictation || BUILTIN_DICTATION[current.dictation] === true;
	if (!replace || current.dictation === ASR_MODEL_SELECTOR) return [];
	handle.override(settings, { ...current, dictation: ASR_MODEL_SELECTOR });
	return [`dictation=${ASR_MODEL_SELECTOR}`];
}

function clearRole(settings: Settings): string[] {
	const handle = lookup("modelRoles");
	if (!handle) return [];
	const current = (handle.get(settings) ?? {}) as Record<string, string>;
	if (current.dictation !== ASR_MODEL_SELECTOR) return [];
	const next = { ...current };
	delete next.dictation;
	handle.override(settings, next);
	return ["dictation"];
}

function report(ctx: ExtensionCommandContext, text: string): void {
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else process.stdout.write(`${text}\n`);
}

function resolveModel(ctx: ExtensionCommandContext, provider: string, id: string): Model {
	const model = ctx.modelRegistry.getAvailable("all").find(m => m.provider === provider && m.id === id);
	if (!model) throw new Error(`${provider}/${id} is not registered`);
	return model;
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

async function runSelftest(ctx: ExtensionCommandContext): Promise<string> {
	const asr = resolveModel(ctx, ASR_PROVIDER, ASR_MODEL_ID);
	const audio = readFileSync(findSelftestWav());
	const transcription = await transcribeAudio(
		asr,
		{ audio, mimeType: "audio/wav", fileName: "selftest.wav", responseFormat: "json" },
		{ apiKey: ctx.modelRegistry.resolver(asr, ctx.sessionManager.getSessionId()) },
	);
	const text = transcription.text.trim();
	if (!text) throw new Error("ASR returned an empty transcript");
	return `ASR ${audio.byteLength} bytes -> ${text}`;
}

function statusText(settings: Settings): string {
	const roles = (lookup("modelRoles")?.get(settings) ?? {}) as Record<string, string>;
	const asrPort = servers.process?.asrPort;
	const lines = [
		`dictation: ${roles.dictation ?? "(default)"}`,
		`ASR: ${asrPort ? `127.0.0.1:${asrPort}` : "unavailable"}  ${config.asr.modelDir}`,
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

	try {
		pi.registerShortcut(config.live.shortcut, {
			description: "Chinese ASR: toggle live dictation",
			handler: async ctx => {
				if (!config.live.enabled) {
					ctx.ui.notify("Live dictation is disabled", "warning");
					return;
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

	pi.on("session_start", async () => {
		if (config.autoSelectRoles) {
			const changed = setRole(pi.pi.settings, false);
			if (changed.length > 0) log(pi, "info", "Chinese ASR role selected", { roles: changed });
		}
		if (config.live.enabled) {
			try {
				const conflict = pi.getShortcutConflict(config.live.shortcut);
				if (conflict) {
					log(pi, "warn", "live dictation shortcut conflict", {
						shortcut: config.live.shortcut,
						kind: conflict.kind,
					});
				}
			} catch {
				// The shortcut check is advisory; a blocked key is reported by the TUI.
			}
		}
	});
	pi.on("session_switch", async () => {
		if (config.autoSelectRoles) setRole(pi.pi.settings, false);
	});
	pi.on("session_shutdown", async () => {
		resetLive();
	});

	pi.registerCommand("asr-zh", {
		description: "Chinese ASR: status, on/off, selftest, live, shortcut, capture",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const settings = pi.pi.settings;
			try {
				switch (subcommand || "status") {
					case "status":
						report(ctx, statusText(settings));
						return;
					case "on": {
						const changed = setRole(settings, true);
						report(ctx, changed.length > 0 ? `enabled: ${changed.join(", ")}` : "already enabled");
						return;
					}
					case "off": {
						const changed = clearRole(settings);
						report(ctx, changed.length > 0 ? `disabled: ${changed.join(", ")}` : "already disabled");
						return;
					}
					case "selftest": {
						setRole(settings, true);
						report(ctx, "running ASR selftest...");
						const result = await runSelftest(ctx);
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
							"usage: /asr-zh [status|on|off|selftest|live [on|off]|shortcut <key>|capture <command|auto>]",
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
