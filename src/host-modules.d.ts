/**
 * Compile-time mirrors of the host modules an OMP extension imports at runtime.
 * OMP resolves these specifiers from its embedded host bundle; they are not
 * installed in this package's node_modules. Keep this file aligned with
 * packages/ai and packages/coding-agent when upgrading OMP.
 */

declare module "@oh-my-pi/pi-ai" {
	export interface Model {
		provider: string;
		id: string;
		api: string;
		baseUrl: string;
		[key: string]: unknown;
	}
}

declare module "@oh-my-pi/pi-ai/transcription" {
	import type { Model } from "@oh-my-pi/pi-ai";

	export function transcribeAudio(
		model: Model,
		request: {
			audio: Uint8Array;
			mimeType: string;
			fileName?: string;
			responseFormat: "json" | "verbose_json";
			language?: string;
		},
		options: { apiKey: unknown; signal?: AbortSignal },
	): Promise<{ text: string }>;
}

declare module "@oh-my-pi/pi-coding-agent/config/settings" {
	export interface Settings {
		[key: string]: unknown;
	}
}

declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

	export interface SettingHandle<T> {
		get(scope: Settings): T;
		override(scope: Settings, value: T): void;
		clearOverride(scope: Settings): void;
	}

	export function lookup<T = unknown>(id: string): SettingHandle<T> | undefined;
}

declare module "@oh-my-pi/pi-coding-agent" {
	import type { Model } from "@oh-my-pi/pi-ai";
	import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

	export interface ExtensionModelRegistry {
		getAvailable(kind: "all" | string): Model[];
		resolver(model: Model, sessionId?: string): unknown;
	}

	export interface ExtensionUIContext {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		getEditorText(): string;
		setEditorText(text: string): void;
		pasteToEditor(text: string): void;
	}

	export interface ExtensionContext {
		hasUI: boolean;
		ui: ExtensionUIContext;
		isIdle(): boolean;
	}

	export interface ExtensionCommandContext extends ExtensionContext {
		modelRegistry: ExtensionModelRegistry;
		sessionManager: { getSessionId(): string };
	}

	export interface ShortcutConflict {
		kind: "reserved" | "keybinding" | "extension";
	}

	export interface ExtensionAPI {
		logger: Record<"debug" | "info" | "warn" | "error", (...args: unknown[]) => void>;
		pi: { settings: Settings };
		on(event: string, handler: (...args: unknown[]) => unknown): void;
		registerProvider(name: string, config: unknown): void;
		registerCommand(
			name: string,
			command: {
				description?: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
			},
		): void;
		registerShortcut(
			shortcut: string,
			options: {
				description?: string;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void;
		getShortcutConflict(shortcut: string): ShortcutConflict | undefined;
	}
}

declare module "@oh-my-pi/pi-utils" {
	export function getTinyModelsCacheDir(): string;
	export function ensureRuntimeInstalled(options: {
		runtimeDir: string;
		install: { dependencies: Record<string, string>; overrides?: Record<string, string>; trustedDependencies?: string[] };
		probePackage?: string;
		onPhase?: (phase: "initiate" | "download" | "done") => void;
	}): Promise<string>;
}
