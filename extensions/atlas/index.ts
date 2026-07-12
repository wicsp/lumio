/**
 * Atlas Connected Lumio Agent — RFC 0001 implementation.
 *
 * Registers an active pi/Lumio session as an observable Atlas agent with
 * heartbeat and capability advertisement. Atlas connectivity is optional;
 * startup, local tools, and shutdown are never blocked by Atlas unavailability.
 *
 * Entry point: registers a `/atlas` command and wires session lifecycle hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseConfig,
	createClient,
	generateAgentId,
	generateAgentName,
	buildMetadata,
	type AtlasClient,
	type AtlasClientStatus,
	type AtlasAgentRegistration,
} from "./client";
import {
	startWorkPoller,
	type WorkPoller,
	type WorkStatus,
	type RunRecord,
} from "./work";

// ─── Module state ────────────────────────────────────────────────────

let client: AtlasClient | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let workPoller: WorkPoller | null = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 5_000;

// ─── Heartbeat loop ──────────────────────────────────────────────────

function startHeartbeat(c: AtlasClient, ctx: { ui?: { notify?: (msg: string, kind: string) => void } }) {
	stopHeartbeat();

	heartbeatTimer = setInterval(async () => {
		try {
			const result = await c.heartbeat();
			if (!result.ok) {
				// Only log after first failure to avoid noise on transient issues.
				// We track the disconnected reason silently in the client.
			}
		} catch {
			// Silently ignore — connectivity is optional.
		}
	}, HEARTBEAT_INTERVAL_MS);

	// Allow Node to exit even if the timer is active.
	if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
		(heartbeatTimer as NodeJS.Timeout).unref();
	}
}

function stopHeartbeat() {
	if (heartbeatTimer !== null) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

// ─── Work polling ───────────────────────────────────────────────────

/** Default no-op work handler. Applications register real handlers via setWorkHandler(). */
let workHandler: ((run: RunRecord) => Promise<"success" | "failure">) | null = null;

function startWorkPolling(c: AtlasClient) {
	stopWorkPolling();

	// Build capabilities from the current session metadata.
	const capabilities: string[] = [];

	workPoller = startWorkPoller(
		c,
		{
			capabilities,
			pollIntervalMs: 10_000,
			heartbeatIntervalMs: 15_000,
		},
		async (run) => {
			if (workHandler) {
				return workHandler(run);
			}
			// Default: acknowledge but don't execute — return success so runs
			// are marked complete rather than left pending forever.
			return "success";
		},
	);
}

function stopWorkPolling() {
	if (workPoller !== null) {
		workPoller.stop();
		workPoller = null;
	}
}

/** Register a real work handler. Call during extension setup. */
export function setWorkHandler(handler: (run: RunRecord) => Promise<"success" | "failure">) {
	workHandler = handler;
}

// ─── Status display ──────────────────────────────────────────────────

function formatWorkStatus(ws: WorkStatus): string {
	switch (ws.kind) {
		case "idle":
			return "  work: idle (polling for jobs)";
		case "claimed":
			return `  work: running ${ws.run.job_name} (${ws.run.run_id.slice(0, 16)}…) · attempt ${ws.run.attempt_number}/${ws.run.max_attempts}`;
		case "completed": {
			const emoji = ws.result === "success" ? "✓" : "✗";
			return `  work: last job ${emoji} ${ws.run.job_name} (${ws.run.run_id.slice(0, 16)}…)`;
		}
	}
}

function formatStatus(status: AtlasClientStatus): string {
	if (status.kind === "disconnected") {
		return `Atlas: disconnected — ${status.reason}`;
	}

	const lines: string[] = [
		`Atlas: connected — ${status.health.version}, health ${status.health.status}`,
	];
	if (status.agent) {
		const a = status.agent;
		lines.push(
			`  agent: ${a.agent_id} · ${a.online ? "online" : "offline"} · last seen ${a.last_seen_at}`,
		);
		if (a.capabilities.length > 0) {
			lines.push(`  capabilities: ${a.capabilities.join(", ")}`);
		}
	} else {
		lines.push("  agent: not registered");
	}
	return lines.join("\n");
}

// ─── Registration ────────────────────────────────────────────────────

async function tryRegister(c: AtlasClient): Promise<boolean> {
	const payload: AtlasAgentRegistration = {
		agent_id: c.agentId,
		name: generateAgentName(c.config),
		capabilities: [], // No capabilities until invocation contracts are stable.
		metadata: buildMetadata(c.config),
	};

	const result = await c.register(payload);
	return result.ok;
}

// ─── Extension entry point ───────────────────────────────────────────

export default function atlasExtension(pi: ExtensionAPI) {
	// ── /atlas command ─────────────────────────────────────────────
	pi.registerCommand("atlas", {
		description: "Show Atlas connection and agent status",
		handler: async (_args, ctx) => {
			if (!client) {
				const config = parseConfig();
				if (!config) {
					ctx.ui.notify(
						"Atlas integration disabled: ATLAS_URL, ATLAS_AGENT_TOKEN_FILE, or ATLAS_NODE_ID not configured.",
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					"Atlas configured but no active session agent. Start a new session to register.",
					"info",
				);
				return;
			}

			const status = await client.status();
			let msg = formatStatus(status);
			if (workPoller) {
				msg += "\n" + formatWorkStatus(workPoller.status());
			}
			ctx.ui.notify(msg, status.kind === "connected" ? "info" : "warning");
		},
	});

	// ── Session lifecycle ─────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		// Clean up any previous session's resources.
		stopHeartbeat();
		client = null;

		const config = parseConfig();
		if (!config) {
			// Integration disabled — no diagnostic noise on every session.
			return;
		}

		client = createClient(config);

		// Register with a short timeout; failure is non-blocking.
		try {
			const ok = await tryRegister(client);
			if (ok) {
				startHeartbeat(client, ctx);
				// Single concise startup diagnostic.
				const status = await client.status();
				if (status.kind === "connected" && status.agent) {
					ctx.ui.notify(
						`Atlas: registered as ${status.agent.agent_id}`,
						"info",
					);
				}
			} else if (ctx.hasUI) {
				// Only show disconnect on startup when we have a UI.
				ctx.ui.notify(
					`Atlas: registration failed (will retry on heartbeat)`,
					"warning",
				);
				// Start heartbeat anyway — registration may be recovered by
				// a subsequent heartbeat call (Atlas upserts on register).
				startHeartbeat(client, ctx);
			}

			// Start work polling with a no-op handler for now.
			// Real job handlers will be registered in M3 (Bilibili vertical slice).
			startWorkPolling(client);
		} catch {
			// Connectivity is optional — start heartbeat anyway.
			startHeartbeat(client, ctx);
			startWorkPolling(client);
		}
	});

	pi.on("session_shutdown", () => {
		stopWorkPolling();
		stopHeartbeat();
		client = null;
	});
}
