/**
 * Fast Mode Extension — unified fast-mode injection for Claude & OpenAI Codex.
 *
 * Per-provider fast mode:
 * - Claude Opus 4.6/4.7/4.8: injects speed="fast" + anthropic-beta header
 * - OpenAI Codex GPT-5.4/5.5: injects service_tier="priority" (OAuth only)
 *
 * Config files (project overrides global):
 * - ~/.pi/agent/extensions/fast-mode.json
 * - <cwd>/.pi/fast-mode.json
 *
 * Commands:
 *   /fast           — toggle fast mode for the current provider
 *   /fast on|off    — set fast mode explicitly
 *   /fast status    — show current state
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── Provider configs ─────────────────────────────────────────────────

type FastOverride = "auto" | "on" | "off";

interface ProviderFastConfig {
	enabled: boolean;
}

interface FastModeConfig {
	/** Show a compact `fast` status label when active. */
	showStatus: boolean;
	claude: ProviderFastConfig & {
		models: string[];
	};
	openai: ProviderFastConfig & {
		models: string[];
	};
}

interface SessionState {
	config: FastModeConfig;
	overrides: Record<FastProvider, FastOverride>;
	lastInjectedAt?: number;
	lastInjectedModel?: string;
}

type RecursivePartial<T> = {
	[P in keyof T]?: T[P] extends object ? RecursivePartial<T[P]> : T[P];
};

// ─── Provider-specific constants ──────────────────────────────────────

const CLAUDE_PROVIDER = "anthropic";
const CLAUDE_API = "anthropic-messages";
const CLAUDE_FAST_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

const OPENAI_PROVIDER = "openai-codex";
const OPENAI_API = "openai-codex-responses";

const EXTENSION_ID = "fast-mode";

const DEFAULT_CONFIG: FastModeConfig = {
	showStatus: true,
	claude: {
		enabled: false,
		models: ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"],
	},
	openai: {
		enabled: false,
		models: ["gpt-5.4", "gpt-5.5"],
	},
};

type FastProvider = "claude" | "openai";
type ProviderMode = FastProvider | null;

interface Eligibility {
	eligible: boolean;
	mode: ProviderMode;
	modelKey: string;
	reason?: string;
}

// ─── Config helpers ───────────────────────────────────────────────────

function readConfigFile(path: string): RecursivePartial<FastModeConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as RecursivePartial<FastModeConfig>;
	} catch (error) {
		console.error(`Warning: Could not parse ${path}: ${error}`);
		return {};
	}
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function mergeConfig(
	base: FastModeConfig,
	overrides: RecursivePartial<FastModeConfig>,
): FastModeConfig {
	const claude = overrides.claude;
	const openai = overrides.openai;
	return {
		showStatus: normalizeBoolean(overrides.showStatus, base.showStatus),
		claude: {
			enabled: normalizeBoolean(claude?.enabled, base.claude.enabled),
			models: Array.isArray(claude?.models) ? claude.models : base.claude.models,
		},
		openai: {
			enabled: normalizeBoolean(openai?.enabled, base.openai.enabled),
			models: Array.isArray(openai?.models) ? openai.models : base.openai.models,
		},
	};
}

function findProjectConfigPath(cwd: string): string {
	let current = cwd;
	while (true) {
		const candidate = join(current, ".pi", "fast-mode.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(cwd, ".pi", "fast-mode.json");
		current = parent;
	}
}

function loadConfig(cwd: string): FastModeConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "fast-mode.json"));
	const projectConfig = readConfigFile(findProjectConfigPath(cwd));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

// ─── Eligibility ──────────────────────────────────────────────────────

function getProviderMode(ctx: ExtensionContext): ProviderMode {
	const model = ctx.model;
	if (!model) return null;
	if (model.provider === CLAUDE_PROVIDER && model.api === CLAUDE_API) return "claude";
	if (model.provider === OPENAI_PROVIDER && model.api === OPENAI_API) return "openai";
	return null;
}

function getEligibility(ctx: ExtensionContext, state: SessionState): Eligibility {
	const model = ctx.model;
	if (!model) return { eligible: false, mode: null, modelKey: "no-model", reason: "no model selected" };

	const key = `${model.provider}/${model.id}`;
	const mode = getProviderMode(ctx);
	if (!mode) {
		return { eligible: false, mode: null, modelKey: key, reason: `provider ${model.provider} is not supported` };
	}

	const providerConfig = mode === "claude" ? state.config.claude : state.config.openai;
	if (!providerConfig.models.includes(model.id)) {
		return {
			eligible: false,
			mode,
			modelKey: key,
			reason: `model ${model.id} not in supported list: [${providerConfig.models.join(", ")}]`,
		};
	}

	// OpenAI Fast mode requires OAuth
	if (mode === "openai" && !ctx.modelRegistry.isUsingOAuth(model)) {
		return {
			eligible: false,
			mode,
			modelKey: key,
			reason: "ChatGPT OAuth auth required; API-key auth not supported for fast mode",
		};
	}

	return { eligible: true, mode, modelKey: key };
}

// ─── State helpers ────────────────────────────────────────────────────

function createSessionState(cwd: string): SessionState {
	return {
		config: loadConfig(cwd),
		overrides: {
			claude: "auto",
			openai: "auto",
		},
	};
}

function isFastEnabled(state: SessionState, mode: ProviderMode): boolean {
	if (!mode) return false;
	const override = state.overrides[mode];
	if (override === "on") return true;
	if (override === "off") return false;
	return state.config[mode].enabled;
}

function describeMode(state: SessionState, mode: ProviderMode): string {
	if (!mode) return "off (unsupported provider)";
	const override = state.overrides[mode];
	if (override === "on") return `on for ${mode} (session override)`;
	if (override === "off") return `off for ${mode} (session override)`;
	return state.config[mode].enabled ? `on for ${mode} (config)` : `off for ${mode} (config)`;
}

// ─── Fast-mode injection ──────────────────────────────────────────────

type PayloadRecord = Record<string, unknown>;
type HeaderModel = { headers?: Record<string, string> };

function splitBetaHeader(value: string | undefined): string[] {
	return (value ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/** Sync Claude anthropic-beta header to include/exclude fast-mode beta. */
function syncClaudeBetaHeader(ctx: ExtensionContext, state: SessionState): void {
	const model = ctx.model as (typeof ctx.model & HeaderModel) | undefined;
	if (!model || model.provider !== CLAUDE_PROVIDER || model.api !== CLAUDE_API) return;

	const eligibility = getEligibility(ctx, state);
	const shouldEnable = eligibility.mode === "claude" && isFastEnabled(state, "claude") && eligibility.eligible;
	const headers = { ...(model.headers ?? {}) };
	const existing = splitBetaHeader(headers["anthropic-beta"] ?? headers["Anthropic-Beta"]);
	const requiredBase = ctx.modelRegistry.isUsingOAuth(model) ? CLAUDE_CODE_OAUTH_BETAS : [];
	const next = shouldEnable
		? Array.from(new Set([...existing, ...requiredBase, CLAUDE_FAST_BETA]))
		: existing.filter((b) => b !== CLAUDE_FAST_BETA);

	delete headers["Anthropic-Beta"];
	if (next.length > 0) headers["anthropic-beta"] = next.join(",");
	else delete headers["anthropic-beta"];
	model.headers = headers;
}

function injectClaudeFastSpeed(
	payload: unknown,
	ctx: ExtensionContext,
	state: SessionState,
): PayloadRecord | undefined {
	if (!isFastEnabled(state, "claude")) return undefined;
	const eligibility = getEligibility(ctx, state);
	if (!eligibility.eligible || eligibility.mode !== "claude") return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== ctx.model?.id) return undefined;
	if ("speed" in payload) return undefined;

	state.lastInjectedAt = Date.now();
	state.lastInjectedModel = `${ctx.model?.provider}/${ctx.model?.id}`;
	return { ...payload, speed: "fast" as const };
}

function injectOpenAIFastServiceTier(
	payload: unknown,
	ctx: ExtensionContext,
	state: SessionState,
): PayloadRecord | undefined {
	if (!isFastEnabled(state, "openai")) return undefined;
	const eligibility = getEligibility(ctx, state);
	if (!eligibility.eligible || eligibility.mode !== "openai") return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== ctx.model?.id) return undefined;
	if ("service_tier" in payload) return undefined;

	state.lastInjectedAt = Date.now();
	state.lastInjectedModel = `${ctx.model?.provider}/${ctx.model?.id}`;
	return { ...payload, service_tier: "priority" };
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

// ─── Status UI ────────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
	syncClaudeBetaHeader(ctx, state);
	if (!ctx.hasUI) return;
	if (!state.config.showStatus) {
		ctx.ui.setStatus(EXTENSION_ID, undefined);
		return;
	}
	const eligibility = getEligibility(ctx, state);
	ctx.ui.setStatus(
		EXTENSION_ID,
		isFastEnabled(state, eligibility.mode) && eligibility.eligible ? "fast" : undefined,
	);
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
	const eligibility = getEligibility(ctx, state);
	const enabled = isFastEnabled(state, eligibility.mode);
	const active = enabled && eligibility.eligible;
	const injected = state.lastInjectedAt
		? ` Last injected for ${state.lastInjectedModel ?? "?"} ${Math.max(0, Math.round((Date.now() - state.lastInjectedAt) / 1000))}s ago.`
		: "";

	if (active) {
		const modeName = eligibility.mode === "claude" ? "Claude Fast" : "OpenAI Fast";
		return `${modeName} mode is ${describeMode(state, eligibility.mode)} → active for ${eligibility.modelKey}.${injected}`;
	}
	if (enabled) {
		return `Fast mode is ${describeMode(state, eligibility.mode)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
	}
	return `Fast mode is ${describeMode(state, eligibility.mode)}. Current model: ${eligibility.modelKey}.${injected}`;
}

// ─── Extension ────────────────────────────────────────────────────────

export default function fastModeExtension(pi: ExtensionAPI) {
	const states = new WeakMap<object, SessionState>();

	function getState(ctx: ExtensionContext): SessionState {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = createSessionState(ctx.cwd);
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	pi.on("session_start", (_event, ctx) => {
		const state = createSessionState(ctx.cwd);
		states.set(ctx.sessionManager, state);
		updateStatus(ctx, state);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx, getState(ctx));
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = getState(ctx);
		const mode = getProviderMode(ctx);

		let nextPayload: PayloadRecord | undefined;
		if (mode === "claude") {
			nextPayload = injectClaudeFastSpeed(event.payload, ctx, state);
		} else if (mode === "openai") {
			nextPayload = injectOpenAIFastServiceTier(event.payload, ctx, state);
		}

		updateStatus(ctx, state);
		return nextPayload;
	});

	pi.registerCommand("fast", {
		description: "Toggle Fast mode for Claude Opus / OpenAI Codex models",
		getArgumentCompletions: (prefix) => {
			const commands = ["on", "off", "toggle", "status"];
			const query = prefix.trim().toLowerCase();
			const matches = commands.filter((c) => c.startsWith(query));
			return matches.length > 0 ? matches.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const state = getState(ctx);
			const action = args.trim().toLowerCase();

			if (action === "status") {
				ctx.ui.notify(getStatusMessage(ctx, state), "info");
				return;
			}

			const mode = getProviderMode(ctx);
			if (!mode) {
				ctx.ui.notify("Current provider does not support Fast mode.", "warning");
				return;
			}

			if (action === "" || action === "toggle") {
				state.overrides[mode] = isFastEnabled(state, mode) ? "off" : "on";
				updateStatus(ctx, state);
				ctx.ui.notify(getStatusMessage(ctx, state), "info");
				return;
			}

			if (action === "on" || action === "enable") {
				state.overrides[mode] = "on";
				updateStatus(ctx, state);
				ctx.ui.notify(getStatusMessage(ctx, state), "info");
				return;
			}

			if (action === "off" || action === "disable") {
				state.overrides[mode] = "off";
				updateStatus(ctx, state);
				ctx.ui.notify(getStatusMessage(ctx, state), "info");
				return;
			}

			ctx.ui.notify("Usage: /fast [on|off|toggle|status]", "warning");
		},
	});
}
