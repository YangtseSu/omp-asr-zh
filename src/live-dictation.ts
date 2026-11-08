import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type LiveState = "idle" | "starting" | "recording" | "stopping";

export interface LiveDictationOptions {
	port: number;
	token: string;
	/** Raw 16 kHz mono s16le capture command, or "auto". */
	capture: string;
	onError?: (error: Error) => void;
	onStateChange?: (state: LiveState) => void;
}

const SAMPLE_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 5_000;
const FINAL_TIMEOUT_MS = 8_000;

function joinText(base: string, text: string): string {
	const next = text.trim();
	if (!next) return base;
	if (!base) return next;
	if (/\s$/.test(base) || /^[\p{P}\p{S}]/u.test(next)) return base + next;
	const asciiEnd = /[A-Za-z0-9]$/.test(base);
	const asciiStart = /^[A-Za-z0-9]/.test(next);
	const cjkEnd = /[\p{Script=Han}]$/u.test(base);
	const cjkStart = /^[\p{Script=Han}]/u.test(next);
	if ((asciiEnd && (asciiStart || cjkStart)) || (cjkEnd && asciiStart)) return `${base} ${next}`;
	return base + next;
}

function autoCaptureCommand(): string {
	if (Bun.which("parec")) {
		return `parec --format=s16le --rate=${SAMPLE_RATE} --channels=1 --latency-msec=50`;
	}
	if (Bun.which("pw-record")) {
		return `pw-record --rate ${SAMPLE_RATE} --channels 1 --format s16 --raw -`;
	}
	if (Bun.which("arecord")) {
		return `arecord -q -f S16_LE -r ${SAMPLE_RATE} -c 1 -t raw`;
	}
	throw new Error("No audio capture tool found; install parec, pw-record, or arecord");
}

/**
 * Drives one live dictation session: capture PCM, stream it to the local ASR
 * server over a WebSocket, and mirror partial/final text into the core editor.
 * Nothing here touches OMP internals; the editor and shortcut are public
 * extension surfaces.
 */
export class LiveDictation {
	#options: LiveDictationOptions;
	#state: LiveState = "idle";
	#capture: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
	#ws: WebSocket | null = null;
	#ctx: ExtensionContext | null = null;
	#baseText = "";
	#cancelled = false;
	#resolveFinal: ((text: string) => void) | null = null;
	#rejectFinal: ((error: Error) => void) | null = null;

	constructor(options: LiveDictationOptions) {
		this.#options = options;
	}

	get state(): LiveState {
		return this.#state;
	}

	async toggle(ctx: ExtensionContext): Promise<void> {
		if (this.#state === "idle") await this.start(ctx);
		else if (this.#state === "recording") await this.stop();
		else this.#options.onError?.(new Error("live dictation is busy"));
	}

	async start(ctx: ExtensionContext): Promise<void> {
		if (this.#state !== "idle") return;
		this.#ctx = ctx;
		this.#baseText = ctx.ui.getEditorText();
		this.#cancelled = false;
		this.#setState("starting");
		try {
			const ws = new WebSocket(
				`ws://127.0.0.1:${this.#options.port}/v1/asr/live?token=${encodeURIComponent(this.#options.token)}`,
			);
			ws.binaryType = "arraybuffer";
			this.#ws = ws;
			await this.#openSocket(ws);
			if (this.#cancelled) {
				this.#cleanup();
				return;
			}
			const capture = this.#spawnCapture();
			this.#capture = capture;
			this.#setState("recording");
			void this.#pump(ws, capture);
		} catch (error) {
			if (this.#cancelled) this.#cleanup();
			else this.#fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	async stop(): Promise<void> {
		if (this.#state !== "recording") return;
		this.#setState("stopping");
		const capture = this.#capture;
		this.#capture = null;
		try {
			capture?.kill();
		} catch {
			// The capture process may have already exited.
		}
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			this.#cleanup();
			return;
		}
		const final = Promise.withResolvers<string>();
		this.#resolveFinal = final.resolve;
		this.#rejectFinal = final.reject;
		const timedOut = Promise.withResolvers<string>();
		const timer = setTimeout(
			() => timedOut.reject(new Error("timed out waiting for the final transcript")),
			FINAL_TIMEOUT_MS,
		);
		try {
			ws.send(JSON.stringify({ type: "stop" }));
			const text = await Promise.race([final.promise, timedOut.promise]);
			this.#render(text);
		} catch (error) {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} finally {
			clearTimeout(timer);
			this.#cleanup();
		}
	}

	dispose(): void {
		this.#cancelled = true;
		const reject = this.#rejectFinal;
		this.#resolveFinal = null;
		this.#rejectFinal = null;
		reject?.(new Error("live dictation disposed"));
		this.#cleanup();
	}

	#spawnCapture(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
		const configured = this.#options.capture.trim();
		const command = configured && configured !== "auto" ? configured : autoCaptureCommand();
		return Bun.spawn({
			cmd: ["sh", "-c", command],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	async #openSocket(ws: WebSocket): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		const timer = setTimeout(() => {
			reject(new Error("timed out connecting to the ASR server"));
		}, CONNECT_TIMEOUT_MS);
		ws.onopen = () => {
			opened = true;
			clearTimeout(timer);
			resolve();
		};
		ws.onerror = () => {
			if (!opened) {
				clearTimeout(timer);
				reject(new Error("failed to connect to the ASR server"));
			}
		};
		ws.onclose = () => {
			clearTimeout(timer);
			if (!opened) {
				reject(new Error("ASR server closed the live connection"));
			} else if (this.#state === "recording") {
				this.#fail(new Error("ASR server closed the live session"));
			}
		};
		await promise;
		ws.onmessage = event => this.#onMessage(event);
	}

	#onMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") return;
		let message: { type?: unknown; text?: unknown; message?: unknown };
		try {
			message = JSON.parse(event.data) as { type?: unknown; text?: unknown; message?: unknown };
		} catch {
			return;
		}
		if (message.type === "partial" && typeof message.text === "string") {
			this.#render(message.text);
		} else if (message.type === "final" && typeof message.text === "string") {
			this.#render(message.text);
			this.#resolveFinal?.(message.text);
			this.#resolveFinal = null;
			this.#rejectFinal = null;
		} else if (message.type === "error") {
			const text = typeof message.message === "string" ? message.message : "ASR server error";
			this.#fail(new Error(text));
		}
	}

	async #pump(ws: WebSocket, capture: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
		const reader = capture.stdout.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (this.#state === "recording" && ws.readyState === WebSocket.OPEN) ws.send(value);
			}
		} catch (error) {
			if (this.#state === "recording") {
				this.#fail(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		} finally {
			reader.releaseLock();
		}
		if (this.#state !== "recording") return;
		const code = await capture.exited;
		if (this.#state === "recording") {
			this.#fail(new Error(`audio capture exited (${code})`));
		}
	}

	#render(text: string): void {
		this.#ctx?.ui.setEditorText(joinText(this.#baseText, text));
	}

	#setState(state: LiveState): void {
		this.#state = state;
		this.#options.onStateChange?.(state);
	}

	#fail(error: Error): void {
		this.#options.onError?.(error);
		const reject = this.#rejectFinal;
		this.#resolveFinal = null;
		this.#rejectFinal = null;
		reject?.(error);
		this.#cleanup();
	}

	#cleanup(): void {
		const capture = this.#capture;
		this.#capture = null;
		try {
			capture?.kill();
		} catch {
			// Ignore an already-exited capture process.
		}
		const ws = this.#ws;
		this.#ws = null;
		try {
			ws?.close();
		} catch {
			// Ignore a socket that is already closed.
		}
		const reject = this.#rejectFinal;
		this.#resolveFinal = null;
		this.#rejectFinal = null;
		reject?.(new Error("live dictation stopped"));
		this.#ctx = null;
		this.#setState("idle");
	}
}
