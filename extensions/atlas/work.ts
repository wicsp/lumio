/**
 * Atlas Work Polling — M2 Reliable Work Execution (Lumio side).
 *
 * Polls Atlas for pending work, claims runs with lease enforcement,
 * heartbeats active claims, and reports results with artifact references.
 * Integration is optional; failure never blocks local pi usage.
 */

import type { AtlasClient } from "./client";

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkConfig {
	/** Agent capabilities to advertise when polling. */
	capabilities: string[];
	/** Poll interval in milliseconds (default: 10s). */
	pollIntervalMs: number;
	/** Heartbeat interval in milliseconds (default: 15s, must be less than Atlas lease TTL). */
	heartbeatIntervalMs: number;
}

export interface ArtifactRef {
	artifact_id: string;
	run_id: string;
	name: string;
	uri: string;
	content_type: string | null;
	size_bytes: number | null;
	checksum: string | null;
	created_at: string;
}

export interface RunRecord {
	run_id: string;
	project_id: string;
	job_name: string;
	capabilities_required: string[];
	input: Record<string, unknown>;
	output: Record<string, unknown> | null;
	status: "pending" | "claimed" | "completed" | "failed" | "cancelled";
	agent_id: string | null;
	lease_expires_at: string | null;
	attempt_number: number;
	max_attempts: number;
	priority: number;
	metadata: Record<string, unknown>;
	error_message: string | null;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export type WorkStatus =
	| { kind: "idle" }
	| {
			kind: "claimed";
			run: RunRecord;
			claimedAt: number;
			lastHeartbeatAt: number;
	  }
	| {
			kind: "completed";
			run: RunRecord;
			completedAt: number;
			result: "success" | "failure";
	  };

// ─── HTTP helpers ────────────────────────────────────────────────────

async function atlasWorkGet<T>(
	client: AtlasClient,
	path: string,
	timeoutMs = 5_000,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	const url = `${client.config.url.replace(/\/+$/, "")}${path}`;
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${client.config.token}`,
			},
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		if (response.ok) {
			return { ok: true, data: (await response.json()) as T };
		}
		return { ok: false, error: `HTTP ${response.status}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function atlasWorkPost<T>(
	client: AtlasClient,
	path: string,
	body?: unknown,
	timeoutMs = 5_000,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	const url = `${client.config.url.replace(/\/+$/, "")}${path}`;
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${client.config.token}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		if (response.ok) {
			return { ok: true, data: (await response.json()) as T };
		}
		return { ok: false, error: `HTTP ${response.status}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ─── Work Poller ─────────────────────────────────────────────────────

export interface WorkPoller {
	readonly config: WorkConfig;
	readonly status: () => WorkStatus;
	stop: () => void;
}

export function startWorkPoller(
	client: AtlasClient,
	cfg: Partial<WorkConfig>,
	onWork: (run: RunRecord) => Promise<"success" | "failure">,
	onStatusChange?: (status: WorkStatus) => void,
): WorkPoller {
	const config: WorkConfig = {
		capabilities: cfg.capabilities ?? [],
		pollIntervalMs: cfg.pollIntervalMs ?? 10_000,
		heartbeatIntervalMs: cfg.heartbeatIntervalMs ?? 15_000,
	};

	let currentRun: RunRecord | null = null;
	let claimedAt = 0;
	let lastHeartbeatAt = 0;
	let completedAt = 0;
	let lastResult: "success" | "failure" = "success";

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let hbTimer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;

	function getStatus(): WorkStatus {
		if (completedAt > 0 && currentRun) {
			return { kind: "completed", run: currentRun, completedAt, result: lastResult };
		}
		if (currentRun) {
			return { kind: "claimed", run: currentRun, claimedAt, lastHeartbeatAt };
		}
		return { kind: "idle" };
	}

	function notifyStatus() {
		onStatusChange?.(getStatus());
	}

	async function claimNext(): Promise<RunRecord | null> {
		const caps = config.capabilities.length > 0
			? `&capabilities=${encodeURIComponent(config.capabilities.join(","))}`
			: "";
		const path = `/api/runs/next?agent_id=${encodeURIComponent(client.agentId)}${caps}`;
		const result = await atlasWorkGet<RunRecord | null>(client, path);
		if (!result.ok) return null;
		return result.data;
	}

	async function sendHeartbeat(runId: string): Promise<boolean> {
		const path = `/api/runs/${encodeURIComponent(runId)}/heartbeat?agent_id=${encodeURIComponent(client.agentId)}`;
		const result = await atlasWorkPost<RunRecord>(client, path);
		return result.ok;
	}

	async function reportComplete(runId: string, output: Record<string, unknown>): Promise<boolean> {
		const payload = {
			agent_id: client.agentId,
			output,
			artifacts: [] as { name: string; uri: string; content_type?: string; size_bytes?: number; checksum?: string }[],
		};
		const path = `/api/runs/${encodeURIComponent(runId)}/complete`;
		const result = await atlasWorkPost<RunRecord>(client, path, payload);
		return result.ok;
	}

	async function reportFailure(runId: string, error: string): Promise<boolean> {
		const payload = {
			agent_id: client.agentId,
			error_message: error,
		};
		const path = `/api/runs/${encodeURIComponent(runId)}/fail`;
		const result = await atlasWorkPost<RunRecord>(client, path, payload);
		return result.ok;
	}

	function startClaimHeartbeat(run: RunRecord) {
		currentRun = run;
		claimedAt = Date.now();
		lastHeartbeatAt = Date.now();
		completedAt = 0;

		stopClaimHeartbeat();
		hbTimer = setInterval(async () => {
			if (stopped || !currentRun) {
				stopClaimHeartbeat();
				return;
			}
			const ok = await sendHeartbeat(run.run_id);
			if (!ok) {
				// Lease lost — go back to idle
				currentRun = null;
				stopClaimHeartbeat();
				notifyStatus();
				return;
			}
			lastHeartbeatAt = Date.now();
		}, config.heartbeatIntervalMs);

		if ("unref" in hbTimer) (hbTimer as NodeJS.Timeout).unref();
		notifyStatus();
	}

	function stopClaimHeartbeat() {
		if (hbTimer !== null) {
			clearInterval(hbTimer);
			hbTimer = null;
		}
	}

	async function executeRun(run: RunRecord) {
		startClaimHeartbeat(run);

		try {
			const result = await onWork(run);
			lastResult = result;

			if (result === "success") {
				await reportComplete(run.run_id, { lumio_agent: client.agentId, result: "ok" });
			} else {
				await reportFailure(run.run_id, "Work handler returned failure");
			}
		} catch (err) {
			lastResult = "failure";
			const msg = err instanceof Error ? err.message : String(err);
			await reportFailure(run.run_id, msg);
		}

		completedAt = Date.now();
		stopClaimHeartbeat();
		notifyStatus();
	}

	async function poll() {
		if (stopped) return;

		// Don't poll if currently executing a run
		if (currentRun && completedAt === 0) return;

		// After completing, return to idle after one cycle
		if (completedAt > 0) {
			currentRun = null;
			completedAt = 0;
			notifyStatus();
		}

		const run = await claimNext();
		if (run) {
			// Don't await — let execution happen in background
			executeRun(run);
		}
	}

	// Start polling
	pollTimer = setInterval(poll, config.pollIntervalMs);
	if ("unref" in pollTimer) (pollTimer as NodeJS.Timeout).unref();

	// Do an initial poll immediately
	poll();

	return {
		config,
		status: getStatus,
		stop: () => {
			stopped = true;
			if (pollTimer !== null) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			stopClaimHeartbeat();
			currentRun = null;
		},
	};
}
