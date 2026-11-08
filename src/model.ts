import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";

/** Cache key under the shared OMP tiny-model directory. */
export const MODEL_REPO = "x-asr-960ms-streaming-zh-en-int8";
export const MODEL_ARCHIVE_NAME =
	"sherpa-onnx-x-asr-960ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2";
export const MODEL_ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE_NAME}`;
/** Pinned official release asset. Update only together with the URL and tests. */
export const MODEL_ARCHIVE_SHA256 = "0a92b798bd6801c333c7ce8aebf5ba769bfe7f3f3511699a67837b2288428603";
export const MODEL_ARCHIVE_BYTES = 133_895_831;

export const MODEL_FILES = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"] as const;

export interface ModelProgress {
	phase: "download" | "extract" | "done";
	loaded: number;
	total: number;
}

export interface EnsureModelOptions {
	signal?: AbortSignal;
	onProgress?: (progress: ModelProgress) => void;
}

/** Standard model directory: the shared OMP tiny-model cache. */
export function defaultModelDir(): string {
	return path.join(getTinyModelsCacheDir(), MODEL_REPO);
}

async function isNonEmptyFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

/** Whether every required model file is present under `dir`. */
export async function isModelReady(dir: string): Promise<boolean> {
	for (const file of MODEL_FILES) {
		if (!(await isNonEmptyFile(path.join(dir, file)))) return false;
	}
	return true;
}

function isSafeArchiveEntry(entry: string): boolean {
	const normalized = entry.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
	return !normalized.split("/").some(segment => segment === "..");
}

async function runTar(args: string[]): Promise<string> {
	const proc = Bun.spawn({
		cmd: ["tar", ...args],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`tar ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`);
	}
	return stdout;
}

async function downloadArchive(dest: string, options: EnsureModelOptions | undefined): Promise<void> {
	const response = await fetch(MODEL_ARCHIVE_URL, { redirect: "follow", signal: options?.signal });
	if (!response.ok || !response.body) {
		throw new Error(`model download failed: HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length") ?? MODEL_ARCHIVE_BYTES) || MODEL_ARCHIVE_BYTES;
	const handle = await fs.open(dest, "w");
	const hash = createHash("sha256");
	let loaded = 0;
	let lastEmitted = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			await handle.write(value);
			hash.update(value);
			loaded += value.byteLength;
			if (loaded - lastEmitted >= 2_000_000 || loaded === total) {
				lastEmitted = loaded;
				options?.onProgress?.({ phase: "download", loaded, total });
			}
		}
	} finally {
		await handle.close();
	}
	const digest = hash.digest("hex");
	if (digest !== MODEL_ARCHIVE_SHA256) {
		await fs.rm(dest, { force: true });
		throw new Error("model archive SHA-256 mismatch");
	}
}

async function findModelRoot(dir: string): Promise<string> {
	const queue = [dir];
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (await isModelReady(current)) return current;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) queue.push(path.join(current, entry.name));
		}
	}
	throw new Error("model archive does not contain the expected X-ASR files");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const abort = (): void => {
		clearTimeout(timer);
		reject(signal?.reason instanceof Error ? signal.reason : new Error("model install aborted"));
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	return promise.finally(() => signal?.removeEventListener("abort", abort));
}

async function cleanupStaleStaging(parent: string): Promise<void> {
	const cutoff = Date.now() - 6 * 60 * 60_000;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(parent, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(".omp-asr-zh-")) continue;
		const dir = path.join(parent, entry.name);
		const owner = Number(/^\.omp-asr-zh-(\d+)-/.exec(entry.name)?.[1]);
		if (owner > 0 && !isProcessAlive(owner)) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
			continue;
		}
		try {
			const stat = await fs.stat(dir);
			if (stat.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
		} catch {
			// Another process may have removed it.
		}
	}
}

/** Serialize installs across OMP sessions. Returns false when another process finished first. */
async function acquireLock(lockPath: string, targetDir: string, options: EnsureModelOptions | undefined): Promise<boolean> {
	const deadline = Date.now() + 15 * 60_000;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n`);
			await handle.close();
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (await isModelReady(targetDir)) return false;
		const pid = Number((await fs.readFile(lockPath, "utf8").catch(() => "")).trim());
		if (pid > 0 && !isProcessAlive(pid)) {
			await fs.rm(lockPath, { force: true });
			continue;
		}
		if (Date.now() > deadline) throw new Error("timed out waiting for another process to install the model");
		await sleep(500, options?.signal);
	}
}

/**
 * Ensure the pinned X-ASR model is installed at `targetDir`.
 *
 * A ready directory is returned as-is. Otherwise the release archive is
 * downloaded into a private staging directory, verified against the pinned
 * SHA-256, extracted with the system `tar`, and atomically moved into place.
 * A lock file serializes concurrent installs from multiple OMP sessions.
 */
export async function ensureModel(targetDir: string, options: EnsureModelOptions = {}): Promise<string> {
	if (await isModelReady(targetDir)) return targetDir;
	await fs.mkdir(path.dirname(targetDir), { recursive: true });
	const lockPath = `${targetDir}.lock`;
	if (!(await acquireLock(lockPath, targetDir, options))) return targetDir;
	await cleanupStaleStaging(path.dirname(targetDir));

	const staging = await fs.mkdtemp(path.join(path.dirname(targetDir), `.omp-asr-zh-${process.pid}-`));
	const cleanupOnExit = (): void => {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch {
			// Best effort during process exit.
		}
		try {
			rmSync(lockPath, { force: true });
		} catch {
			// Best effort during process exit.
		}
	};
	process.once("exit", cleanupOnExit);
	try {
		if (await isModelReady(targetDir)) return targetDir;
		const archive = path.join(staging, "model.tar.bz2");
		await downloadArchive(archive, options);
		options?.onProgress?.({ phase: "extract", loaded: 0, total: 0 });
		const entries = await runTar(["-tjf", archive]);
		for (const entry of entries.split("\n").map(line => line.trim()).filter(Boolean)) {
			if (!isSafeArchiveEntry(entry)) throw new Error(`model archive contains an unsafe path: ${entry}`);
		}
		await runTar(["-xjf", archive, "-C", staging]);
		const root = await findModelRoot(staging);
		await fs.rm(targetDir, { recursive: true, force: true });
		await fs.rename(root, targetDir);
		options?.onProgress?.({ phase: "done", loaded: MODEL_ARCHIVE_BYTES, total: MODEL_ARCHIVE_BYTES });
		return targetDir;
	} finally {
		process.off("exit", cleanupOnExit);
		await fs.rm(staging, { recursive: true, force: true });
		await fs.rm(lockPath, { force: true });
	}
}
