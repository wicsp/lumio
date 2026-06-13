/**
 * Bark Push Notification Extension
 *
 * Sends a push notification via Bark (or compatible webhook) when pi finishes
 * an agent turn and is ready for more input.
 *
 * Config files (project overrides global):
 * - ~/.pi/agent/extensions/bark.json
 * - <cwd>/.pi/bark.json
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

interface BarkConfig {
	enabled: boolean;
	onlyWhenInteractive: boolean;
	webhook: string;
	idleSeconds: number | null;
	title: string;
	message: string;
	includeLastAssistantMessage: boolean;
	sound: string;
	openUrl: string;
	imageUrl: string;
}

interface BarkPayload {
	message: string;
	title?: string;
	subtitle?: string;
	sound?: string;
	url?: string;
}

const DEFAULT_CONFIG: BarkConfig = {
	enabled: true,
	onlyWhenInteractive: true,
	webhook: "$BARK_URL",
	idleSeconds: 20,
	title: "Pi finished",
	message: "Pi finished working in '{project}'.",
	includeLastAssistantMessage: true,
	sound: "",
	openUrl: "",
	imageUrl: "",
};

function readConfigFile(path: string): Partial<BarkConfig> {
	if (!existsSync(path)) return {};

	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<BarkConfig>;
	} catch (error) {
		console.error(`Warning: Could not parse ${path}: ${error}`);
		return {};
	}
}

function mergeConfig(base: BarkConfig, overrides: Partial<BarkConfig>): BarkConfig {
	return {
		...base,
		...overrides,
	};
}

function loadConfig(cwd: string): BarkConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "bark.json"));
	const projectConfig = readConfigFile(join(cwd, ".pi", "bark.json"));
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function resolveWebhook(raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;

	const envMatch = value.match(/^\$([A-Z0-9_]+)$/) ?? value.match(/^\$\{([A-Z0-9_]+)\}$/);
	if (envMatch) return process.env[envMatch[1]]?.trim() || undefined;

	return value;
}

function isValidWebhookUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

async function getMacOsIdleSeconds(): Promise<number | null> {
	if (process.platform !== "darwin") return null;

	try {
		const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem"], {
			timeout: 1000,
			maxBuffer: 1024 * 1024,
		});
		const match = stdout.match(/HIDIdleTime"\s*=\s*(\d+)/) ?? stdout.match(/HIDIdleTime\s+=\s+(\d+)/);
		if (!match) return null;

		const idleNanoseconds = Number(match[1]);
		if (!Number.isFinite(idleNanoseconds)) return null;

		return Math.floor(idleNanoseconds / 1_000_000_000);
	} catch {
		return null;
	}
}

async function shouldSkipForIdleThreshold(idleSeconds: number | null): Promise<boolean> {
	if (idleSeconds === null) return false;
	if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return false;

	const currentIdleSeconds = await getMacOsIdleSeconds();
	if (currentIdleSeconds === null) return false;

	return currentIdleSeconds < idleSeconds;
}

function formatTemplate(template: string, cwd: string): string {
	const project = basename(cwd || process.cwd());
	return template.replaceAll("{project}", project).replaceAll("{cwd}", cwd);
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (typeof part !== "object" || part === null) continue;

		const maybeText = (part as { text?: unknown }).text;
		if (typeof maybeText === "string") parts.push(maybeText);
	}

	return parts.join("\n");
}

function lastAssistantMessage(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;

		const text = extractTextContent((message as { content?: unknown }).content).trim();
		if (text) return text;
	}

	return undefined;
}

function truncateMessage(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 800) return trimmed;
	return `${trimmed.slice(0, 797).trimEnd()}...`;
}

async function sendBark(webhook: string, payload: BarkPayload): Promise<{ ok: boolean; error?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);

	try {
		const reqBody: Record<string, string> = { body: payload.message };
		if (payload.title) reqBody.title = payload.title;
		if (payload.subtitle) reqBody.subtitle = payload.subtitle;
		if (payload.sound) reqBody.sound = payload.sound;
		if (payload.url) reqBody.url = payload.url;

		const response = await fetch(webhook, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify(reqBody),
			signal: controller.signal,
		});

		if (response.ok) return { ok: true };
		return { ok: false, error: `Unexpected response status ${response.status}.` };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "Unknown webhook failure." };
	} finally {
		clearTimeout(timeout);
	}
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function describeConfig(config: BarkConfig, webhook: string | undefined): string {
	const webhookStatus = webhook ? (isValidWebhookUrl(webhook) ? "configured" : "invalid") : "missing";
	const idle = config.idleSeconds === null ? "off" : `${config.idleSeconds}s`;
	return `bark is ${config.enabled ? "enabled" : "disabled"}; webhook ${webhookStatus}; idle threshold ${idle}.`;
}

export default function barkExtension(pi: ExtensionAPI) {
	pi.registerCommand("bark", {
		description: "Show bark notification status",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			notify(ctx, describeConfig(config, resolveWebhook(config.webhook)));
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;
		if (config.onlyWhenInteractive && !ctx.hasUI) return;

		const webhook = resolveWebhook(config.webhook);
		if (!webhook || !isValidWebhookUrl(webhook)) return;
		if (await shouldSkipForIdleThreshold(config.idleSeconds)) return;

		const assistantMessage = config.includeLastAssistantMessage ? lastAssistantMessage(event.messages as readonly unknown[]) : undefined;
		const message = truncateMessage(assistantMessage || formatTemplate(config.message, ctx.cwd));
		const result = await sendBark(webhook, {
			title: formatTemplate(config.title, ctx.cwd),
			message,
			sound: config.sound.trim() || undefined,
			url: config.openUrl.trim() || undefined,
		});

		if (!result.ok && result.error) {
			console.error(`bark notification failed: ${result.error}`);
		}
	});
}
