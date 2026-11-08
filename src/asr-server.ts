import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { ServerWebSocket } from "bun";

import { log } from "./log";

interface SherpaOnlineStream {
	acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void;
	inputFinished(): void;
}

interface SherpaOnlineRecognizer {
	createStream(): SherpaOnlineStream;
	isReady(stream: SherpaOnlineStream): boolean;
	decode(stream: SherpaOnlineStream): void;
	getResult(stream: SherpaOnlineStream): { text: string };
}

interface SherpaRuntime {
	OnlineRecognizer: new (config: {
		modelConfig: {
			transducer: { encoder: string; decoder: string; joiner: string };
			tokens: string;
			modelType: string;
			numThreads: number;
			provider: string;
			debug: number;
		};
		decodingMethod: string;
		enableEndpoint: boolean;
	}) => SherpaOnlineRecognizer;
}

export interface AsrServerConfig {
	runtimeEntry: string;
	modelDir: string;
	modelType: string;
	numThreads: number;
	tailPaddingSeconds: number;
	token: string;
}

export interface AsrServer {
	port: number;
}

interface LiveData {
	stream?: SherpaOnlineStream;
	lastText: string;
	carry?: Uint8Array;
}

const SAMPLE_RATE = 16_000;
let recognizer: SherpaOnlineRecognizer | undefined;
let modelLock = Promise.resolve();
let liveActive = false;

function pickFile(dir: string, base: string, quantized: string): string {
	const preferred = path.join(dir, quantized);
	if (existsSync(preferred)) return preferred;
	const fallback = path.join(dir, base);
	if (existsSync(fallback)) return fallback;
	throw new Error(`Missing ${quantized} (or ${base}) under ${dir}`);
}

function createRecognizer(config: AsrServerConfig): SherpaOnlineRecognizer {
	const runtime = createRequire(config.runtimeEntry)(config.runtimeEntry) as SherpaRuntime;
	const startedAt = performance.now();
	const next = new runtime.OnlineRecognizer({
		modelConfig: {
			transducer: {
				encoder: pickFile(config.modelDir, "encoder.onnx", "encoder.int8.onnx"),
				decoder: pickFile(config.modelDir, "decoder.onnx", "decoder.int8.onnx"),
				joiner: pickFile(config.modelDir, "joiner.onnx", "joiner.int8.onnx"),
			},
			tokens: pickFile(config.modelDir, "tokens.txt", "tokens.txt"),
			modelType: config.modelType,
			numThreads: config.numThreads,
			provider: "cpu",
			debug: 0,
		},
		decodingMethod: "greedy_search",
		enableEndpoint: true,
	});
	log("info", "ASR model loaded", {
		modelDir: config.modelDir,
		modelType: config.modelType,
		threads: config.numThreads,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
	return next;
}

function getRecognizer(config: AsrServerConfig): SherpaOnlineRecognizer {
	recognizer ??= createRecognizer(config);
	return recognizer;
}

function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
	if (bytes.byteLength < 12) throw new Error("Audio payload is too short to be a WAV file");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
	const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
	if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Audio payload is not a RIFF/WAVE file");

	let format = 0;
	let channels = 1;
	let sampleRate = SAMPLE_RATE;
	let bitsPerSample = 16;
	let dataOffset = -1;
	let dataLength = 0;
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = String.fromCharCode(
			view.getUint8(offset),
			view.getUint8(offset + 1),
			view.getUint8(offset + 2),
			view.getUint8(offset + 3),
		);
		const size = view.getUint32(offset + 4, true);
		if (id === "fmt " && offset + 24 <= bytes.byteLength) {
			format = view.getUint16(offset + 8, true);
			channels = view.getUint16(offset + 10, true);
			sampleRate = view.getUint32(offset + 12, true);
			bitsPerSample = view.getUint16(offset + 22, true);
		} else if (id === "data") {
			dataOffset = offset + 8;
			dataLength = Math.min(size, bytes.byteLength - dataOffset);
		}
		offset += 8 + size + (size & 1);
	}
	if (dataOffset < 0 || dataLength === 0) throw new Error("WAV file has no audio data");
	if (channels < 1) throw new Error(`Unsupported WAV channel count: ${channels}`);

	const bytesPerSample = bitsPerSample / 8;
	const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
	const samples = new Float32Array(frameCount);
	for (let frame = 0; frame < frameCount; frame += 1) {
		let mixed = 0;
		for (let channel = 0; channel < channels; channel += 1) {
			const sampleOffset = dataOffset + (frame * channels + channel) * bytesPerSample;
			if (format === 3 && bitsPerSample === 32) mixed += view.getFloat32(sampleOffset, true);
			else if (format === 1 && bitsPerSample === 16) mixed += view.getInt16(sampleOffset, true) / 32_768;
			else if (format === 1 && bitsPerSample === 32) mixed += view.getInt32(sampleOffset, true) / 2_147_483_648;
			else if (format === 1 && bitsPerSample === 24) {
				const lo = view.getUint8(sampleOffset);
				const mid = view.getUint8(sampleOffset + 1);
				const hi = view.getInt8(sampleOffset + 2);
				mixed += ((hi << 16) | (mid << 8) | lo) / 8_388_608;
			} else {
				throw new Error(`Unsupported WAV encoding: format=${format} bits=${bitsPerSample}`);
			}
		}
		samples[frame] = mixed / channels;
	}
	return { samples, sampleRate };
}

function transcribe(config: AsrServerConfig, samples: Float32Array, sampleRate: number): string {
	const active = getRecognizer(config);
	const stream = active.createStream();
	stream.acceptWaveform({ samples, sampleRate });
	stream.acceptWaveform({
		samples: new Float32Array(Math.round(sampleRate * config.tailPaddingSeconds)),
		sampleRate,
	});
	stream.inputFinished();
	while (active.isReady(stream)) active.decode(stream);
	return active.getResult(stream).text.trim();
}

function runExclusive<T>(work: () => T): Promise<T> {
	const run = modelLock.then(work, work);
	modelLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function pcm16ToFloat(
	bytes: Uint8Array,
	carry: Uint8Array | undefined,
): { samples: Float32Array; carry?: Uint8Array } {
	let data = bytes;
	if (carry && carry.length > 0) {
		const merged = new Uint8Array(carry.length + bytes.length);
		merged.set(carry);
		merged.set(bytes, carry.length);
		data = merged;
	}
	const usable = data.length & ~1;
	const view = new DataView(data.buffer, data.byteOffset, usable);
	const samples = new Float32Array(usable / 2);
	for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768;
	return { samples, carry: usable < data.length ? data.slice(usable) : undefined };
}

function finishLive(ws: ServerWebSocket<LiveData>, config: AsrServerConfig): void {
	const stream = ws.data.stream;
	if (!stream) {
		ws.close();
		return;
	}
	try {
		stream.acceptWaveform({
			samples: new Float32Array(Math.round(SAMPLE_RATE * config.tailPaddingSeconds)),
			sampleRate: SAMPLE_RATE,
		});
		stream.inputFinished();
		const active = getRecognizer(config);
		while (active.isReady(stream)) active.decode(stream);
		const text = active.getResult(stream).text.trim();
		ws.send(JSON.stringify({ type: "final", text }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log("error", "live ASR final decode failed", { error: message });
		ws.send(JSON.stringify({ type: "error", message }));
	} finally {
		ws.data.stream = undefined;
		ws.close();
	}
}

async function handleRequest(request: Request, config: AsrServerConfig): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	if (new URL(request.url).pathname !== "/v1/audio/transcriptions") {
		return new Response("Not found", { status: 404 });
	}
	if (request.headers.get("authorization") !== `Bearer ${config.token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	try {
		const form = await request.formData();
		const file = form.get("file");
		if (!(file instanceof Blob)) return Response.json({ error: { message: "Missing audio file" } }, { status: 400 });
		const { samples, sampleRate } = decodeWav(new Uint8Array(await file.arrayBuffer()));
		const text = await runExclusive(() => transcribe(config, samples, sampleRate));
		return Response.json({ text });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log("error", "ASR request failed", { error: message });
		return Response.json({ error: { message } }, { status: 500 });
	}
}

export function startAsrServer(config: AsrServerConfig): AsrServer {
	const server = Bun.serve<LiveData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname === "/v1/asr/live") {
				if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
					return new Response("Upgrade required", { status: 426 });
				}
				if (url.searchParams.get("token") !== config.token) {
					return new Response("Unauthorized", { status: 401 });
				}
				if (liveActive) return new Response("Live session already active", { status: 409 });
				const upgraded = server.upgrade(request, { data: { lastText: "" } });
				return upgraded ? undefined : new Response("Upgrade failed", { status: 500 });
			}
			return handleRequest(request, config);
		},
		websocket: {
			open(ws) {
				liveActive = true;
				try {
					ws.data.stream = getRecognizer(config).createStream();
					log("info", "live ASR session started");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					liveActive = false;
					log("error", "live ASR model load failed", { error: message });
					ws.send(JSON.stringify({ type: "error", message }));
					ws.close(1011, "model load failed");
				}
			},
			message(ws, message) {
				if (typeof message === "string") {
					try {
						const parsed = JSON.parse(message) as { type?: unknown };
						if (parsed.type === "stop") finishLive(ws, config);
					} catch {
						ws.send(JSON.stringify({ type: "error", message: "Invalid control message" }));
					}
					return;
				}
				const stream = ws.data.stream;
				if (!stream) return;
				const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
				const { samples, carry } = pcm16ToFloat(bytes, ws.data.carry);
				ws.data.carry = carry;
				if (samples.length === 0) return;
				try {
					stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
					const active = getRecognizer(config);
					while (active.isReady(stream)) active.decode(stream);
					const text = active.getResult(stream).text.trim();
					if (text && text !== ws.data.lastText) {
						ws.data.lastText = text;
						ws.send(JSON.stringify({ type: "partial", text }));
					}
				} catch (error) {
					const messageText = error instanceof Error ? error.message : String(error);
					log("error", "live ASR decode failed", { error: messageText });
					ws.send(JSON.stringify({ type: "error", message: messageText }));
					ws.data.stream = undefined;
					ws.close(1011, "decode failed");
				}
			},
			close(ws) {
				liveActive = false;
				ws.data.stream = undefined;
				log("info", "live ASR session closed");
			},
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("ASR server did not bind a port");
	log("info", "ASR server listening", { port, modelDir: config.modelDir });
	return { port };
}
