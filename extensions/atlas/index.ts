/**
 * Atlas Connected Lumio Agent — RFC 0001 + M2.5 Execution Hardening.
 *
 * Registers an active pi/Lumio session as an observable Atlas agent with
 * heartbeat and capability advertisement. Atlas connectivity is optional;
 * startup, local tools, and shutdown are never blocked by Atlas unavailability.
 *
 * M2.5 changes:
 *   - Unknown jobs are explicitly failed (no silent success).
 *   - /atlas:enqueue sets capabilities_required.
 *   - Handler signature uses typed HandlerResult instead of raw strings.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
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
  type HandlerResult,
  type HandlerSuccess,
} from "./work";
import { bilibiliSummaryHandler, extractBvid } from "./jobs/bilibili";
import {
  configuredVaultPath,
  ensureVaultStructure,
  removeResourceCard,
  type ResourceCardProjection,
  type ResourceCardRemoval,
  type AtlasResourceRecord,
  type AtlasSourceRecord,
} from "./obsidian";
import { createPiBilibiliSummaryGenerator } from "./summarize";
import {
  createResourceComment,
  fetchResourceBundle,
  projectResourceBundle,
  vortexCommentHandler,
  type AtlasResourceBundle,
} from "./resource-review";
import { vortexResourcePurgeHandler } from "./resource-purge";

// ─── Module state ────────────────────────────────────────────────────

let client: AtlasClient | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let workPoller: WorkPoller | null = null;
let summaryRuntime: { model: Model<any>; modelRegistry: ModelRegistry } | null = null;

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

// ─── Job router ─────────────────────────────────────────────────────

/** Job handlers registered by name. M2.5: returns typed HandlerResult. */
const jobHandlers = new Map<
  string,
  (run: RunRecord, signal: AbortSignal) => Promise<HandlerResult>
>();

/** Register a job handler for a given job_name. */
export function registerJobHandler(
  name: string,
  handler: (run: RunRecord, signal: AbortSignal) => Promise<HandlerResult>,
) {
  jobHandlers.set(name, handler);
}

async function projectPublishedResources(
  c: AtlasClient,
  _run: RunRecord,
  result: HandlerSuccess,
): Promise<void> {
  if (!configuredVaultPath()) return;
  for (const resource of result.resources) {
    if (resource.kind !== "summary") continue;
    await projectResourceBundle(await fetchResourceBundle(c, resource.resource_id));
  }
}

export interface ResourceCardReconciliation {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

/** Make the rebuildable Resource Card projection match Atlas' current review metadata. */
export async function reconcileResourceCards(
  c: Pick<AtlasClient, "controlGet">,
): Promise<ResourceCardReconciliation> {
  const vaultPath = configuredVaultPath();
  if (!vaultPath) throw new Error("ATLAS_OBSIDIAN_VAULT is not configured");
  await ensureVaultStructure(vaultPath);
  const response = await c.controlGet<AtlasResourceRecord[]>(
    "/api/resources?kind=summary&limit=500",
  );
  if (!response.ok) throw new Error(response.error);

  const result: ResourceCardReconciliation = {
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    failed: 0,
    errors: [],
  };
  let cursor = 0;
  const workerCount = Math.min(4, response.data.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < response.data.length) {
      const resource = response.data[cursor++];
      try {
        if (resource.review_status === "dismissed") {
          const removal = await removeResourceCard(vaultPath, resource.resource_id);
          result[removal.removed ? "removed" : "unchanged"] += 1;
          continue;
        }
        const bundleResponse = await c.controlGet<AtlasResourceBundle>(
          `/api/resources/${encodeURIComponent(resource.resource_id)}/bundle`,
        );
        if (!bundleResponse.ok) throw new Error(bundleResponse.error);
        const projection = await projectResourceBundle(bundleResponse.data);
        if (projection) result[projection.action] += 1;
      } catch (error) {
        result.failed += 1;
        if (result.errors.length < 3) {
          const detail = error instanceof Error ? error.message : String(error);
          result.errors.push(`${resource.resource_id}: ${detail}`);
        }
      }
    }
  });
  await Promise.all(workers);
  return result;
}

function formatReconciliation(result: ResourceCardReconciliation): string {
  const counts = [
    `created ${result.created}`,
    `updated ${result.updated}`,
    `removed ${result.removed}`,
    `unchanged ${result.unchanged}`,
    `failed ${result.failed}`,
  ].join(", ");
  return result.errors.length > 0 ? `${counts}; ${result.errors.join("; ")}` : counts;
}

/**
 * Dispatch a claimed run to the appropriate handler.
 * M2.5: unknown jobs are explicitly failed instead of silently succeeding.
 */
async function dispatchJob(
  run: RunRecord,
  signal: AbortSignal,
): Promise<HandlerResult> {
  const handler = jobHandlers.get(run.job_name);
  if (handler) return handler(run, signal);

  // No handler registered — fail explicitly.
  return {
    status: "failure",
    code: "unsupported_job",
    message: `No handler registered for job: ${run.job_name}`,
    retryable: false,
  };
}

function startWorkPolling(c: AtlasClient, ui: { setStatus: (k: string, v: string | undefined) => void }) {
  stopWorkPolling();

  const capabilities = Array.from(jobHandlers.keys());

  workPoller = startWorkPoller(
    c,
    {
      capabilities,
      pollIntervalMs: 10_000,
      heartbeatIntervalMs: 15_000,
    },
    dispatchJob,
    (ws) => {
      ui.setStatus("atlas-work", compactWorkStatus(ws));
    },
    (run, result) => projectPublishedResources(c, run, result),
  );
}

function stopWorkPolling() {
  if (workPoller !== null) {
    workPoller.stop();
    workPoller = null;
  }
}

// ─── Work status for footer ─────────────────────────────────────────

function compactWorkStatus(ws: WorkStatus): string {
  switch (ws.kind) {
    case "idle":
      return "Atlas: idle";
    case "claimed":
      return `Atlas: running ${ws.run.job_name}`;
    case "completed":
      return ws.result === "success"
        ? `Atlas: ✓ ${ws.run.job_name}`
        : `Atlas: ✗ ${ws.run.job_name}`;
    case "abandoned":
      return `Atlas: ⚠ ${ws.run.job_name}`;
  }
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
      return `  work: last job ${emoji} ${ws.run.job_name} (${ws.run.run_id.slice(0, 16)}…) · ${ws.detail}`;
    }
    case "abandoned":
      return `  work: ⚠ lease lost — ${ws.run.job_name} (${ws.run.run_id.slice(0, 16)}…) · ${ws.reason}`;
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
    capabilities: Array.from(jobHandlers.keys()),
    metadata: buildMetadata(c.config, c.agentId.split(".").at(-1)),
  };

  const result = await c.register(payload);
  return result.ok;
}

// ─── Extension entry point ───────────────────────────────────────────

export default function atlasExtension(pi: ExtensionAPI) {
  // ── Register job handlers ────────────────────────────────────
  const summarize = createPiBilibiliSummaryGenerator(() => summaryRuntime);
  registerJobHandler(
    "bilibili-summary-v4",
    (run, signal) => bilibiliSummaryHandler(run, signal, summarize),
  );
  registerJobHandler("vortex-comment-v1", (run, signal) => {
    const activeClient = client;
    if (!activeClient) {
      return Promise.resolve({
        status: "failure" as const,
        code: "atlas_unavailable",
        message: "Atlas client is not available in this Lumio session",
        retryable: true,
      });
    }
    return vortexCommentHandler(run, signal, activeClient);
  });
  registerJobHandler("vortex-resource-purge-v1", vortexResourcePurgeHandler);

  // ── /atlas enqueue command ───────────────────────────────────
  pi.registerCommand("atlas:enqueue", {
    description: "Enqueue a Bilibili video URL for summary processing",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /atlas:enqueue <B站视频URL>", "warning");
        return;
      }

      if (!client) {
        ctx.ui.notify("Atlas not connected. Start a new session to activate.", "warning");
        return;
      }

      const bvid = extractBvid(url);
      if (!bvid) {
        ctx.ui.notify("Invalid B站 URL — must contain a BV号 (e.g. BV1xx411c7mD).", "warning");
        return;
      }

      try {
        const canonicalUrl = `https://www.bilibili.com/video/${bvid}`;
        const source = await client.controlPost<AtlasSourceRecord>(
          "/api/sources",
          {
            source_key: `bilibili:${bvid}`,
            kind: "video",
            canonical_uri: canonicalUrl,
            title: null,
            external_ids: { bvid },
            metadata: { captured_via: "lumio", capture_url: url },
          },
        );
        if (!source.ok) {
          ctx.ui.notify(`Atlas Source capture failed: ${source.error}`, "warning");
          return;
        }

        // Ensure bilibili-capture project exists.
        await client.controlPost("/api/projects", {
          project_id: "bilibili-capture",
          name: "Bilibili Video Capture",
          description: "Inbox for B站 video URLs captured from Share Sheet.",
        });

        const enqueued = await client.controlPost<RunRecord>("/api/runs/enqueue", {
          project_id: "bilibili-capture",
          job_name: "bilibili-summary-v4",
          capabilities_required: ["bilibili-summary-v4"],
          input: {
            url,
            canonical_url: canonicalUrl,
            source_id: source.data.source_id,
          },
          priority: 5,
        });
        if (enqueued.ok) {
          ctx.ui.notify(
            `Atlas: captured ${bvid} as ${source.data.source_id}; enqueued ${enqueued.data.run_id}.`,
            "info",
          );
        } else {
          ctx.ui.notify(`Atlas enqueue failed: ${enqueued.error}`, "warning");
        }
      } catch (err) {
        ctx.ui.notify(`Atlas enqueue error: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  pi.registerCommand("atlas:reconcile", {
    description: "Reconcile all Atlas summary Resource Cards into Vortex",
    handler: async (_args, ctx) => {
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const result = await reconcileResourceCards(client);
        ctx.ui.notify(
          `Atlas reconciliation: ${formatReconciliation(result)}.`,
          result.failed > 0 ? "warning" : "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Atlas reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("atlas:comment", {
    description: "Create a blank human Knowledge Comment for one Atlas Resource",
    handler: async (args, ctx) => {
      const resourceId = args.trim();
      if (!resourceId) {
        ctx.ui.notify("Usage: /atlas:comment <resource_id>", "warning");
        return;
      }
      const vaultPath = configuredVaultPath();
      if (!client || !vaultPath) {
        ctx.ui.notify("Atlas or ATLAS_OBSIDIAN_VAULT is not configured.", "warning");
        return;
      }
      try {
        const result = await createResourceComment(client, resourceId, { vaultPath });
        ctx.ui.notify(
          `${result.draft.created ? "Created" : "Kept existing"} ${result.draft.relative_path}; Resource is reviewed${result.projection ? ` and card ${result.projection.action}` : ""}. Write the comment yourself in Obsidian.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Atlas comment setup failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("atlas:dismiss", {
    description: "Dismiss one Atlas Resource and remove its rebuildable Vortex card",
    handler: async (args, ctx) => {
      const resourceId = args.trim();
      if (!resourceId) {
        ctx.ui.notify("Usage: /atlas:dismiss <resource_id>", "warning");
        return;
      }
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const dismissed = await client.controlPatch<AtlasResourceRecord>(
          `/api/resources/${encodeURIComponent(resourceId)}/review`,
          { review_status: "dismissed" },
        );
        if (!dismissed.ok) {
          ctx.ui.notify(`Atlas dismiss refused: ${dismissed.error}`, "warning");
          return;
        }

        const vaultPath = configuredVaultPath();
        if (dismissed.data.kind === "summary" && vaultPath) {
          let removal: ResourceCardRemoval;
          try {
            removal = await removeResourceCard(vaultPath, resourceId);
          } catch (err) {
            ctx.ui.notify(
              `Atlas dismissed ${resourceId}, but local card removal failed: ${err instanceof Error ? err.message : String(err)}. Reconciliation will retry it.`,
              "warning",
            );
            return;
          }
          ctx.ui.notify(
            `Atlas: dismissed ${resourceId}; Resource Card ${removal.removed ? "removed" : "was already absent"}.`,
            "info",
          );
        } else {
          ctx.ui.notify(`Atlas: dismissed ${resourceId}.`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Atlas dismiss failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("atlas:restore", {
    description: "Restore one dismissed Atlas Resource to pending review",
    handler: async (args, ctx) => {
      const resourceId = args.trim();
      if (!resourceId) {
        ctx.ui.notify("Usage: /atlas:restore <resource_id>", "warning");
        return;
      }
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const restored = await client.controlPatch<AtlasResourceRecord>(
          `/api/resources/${encodeURIComponent(resourceId)}/review`,
          { review_status: "pending" },
        );
        if (!restored.ok) {
          ctx.ui.notify(`Atlas restore failed: ${restored.error}`, "warning");
          return;
        }

        let projection: ResourceCardProjection | null = null;
        if (restored.data.kind === "summary" && configuredVaultPath()) {
          try {
            const bundle = await fetchResourceBundle(client, resourceId);
            projection = await projectResourceBundle({ ...bundle, resource: restored.data });
          } catch (err) {
            ctx.ui.notify(
              `Atlas restored ${resourceId} to pending, but card projection failed: ${err instanceof Error ? err.message : String(err)}. Reconciliation will retry it.`,
              "warning",
            );
            return;
          }
        }
        ctx.ui.notify(
          `Atlas: restored ${resourceId} to pending${projection ? `; Resource Card ${projection.action}` : ""}.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Atlas restore failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

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
    summaryRuntime = null;

    const config = parseConfig();
    if (!config) {
      // Integration disabled — no diagnostic noise on every session.
      return;
    }

    summaryRuntime = ctx.model
      ? { model: ctx.model, modelRegistry: ctx.modelRegistry }
      : null;
    client = createClient(config, ctx.sessionManager.getSessionId());

    const vaultPath = configuredVaultPath();
    if (vaultPath) {
      try {
        await ensureVaultStructure(vaultPath);
      } catch (err) {
        ctx.ui.notify(
          `Vortex bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }

    // Register with a short timeout; failure is non-blocking.
    try {
      const ok = await tryRegister(client);
      if (ok) {
        startHeartbeat(client, ctx);
        let reconciliationText = "";
        let reconciliationFailed = false;
        if (vaultPath) {
          try {
            const result = await reconcileResourceCards(client);
            reconciliationText = `; Vortex ${formatReconciliation(result)}`;
            reconciliationFailed = result.failed > 0;
          } catch (err) {
            reconciliationFailed = true;
            reconciliationText = `; Vortex reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Single startup diagnostic includes the projection result, so reconciliation is visible.
        const status = await client.status();
        if (status.kind === "connected" && status.agent) {
          ctx.ui.notify(
            `Atlas: registered as ${status.agent.agent_id}${reconciliationText}`,
            reconciliationFailed ? "warning" : "info",
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

      startWorkPolling(client, ctx.ui);
    } catch {
      // Connectivity is optional — start heartbeat anyway.
      startHeartbeat(client, ctx);
      startWorkPolling(client, ctx.ui);
    }
  });

  pi.on("model_select", (event, ctx) => {
    summaryRuntime = { model: event.model, modelRegistry: ctx.modelRegistry };
  });

  pi.on("session_shutdown", () => {
    stopWorkPolling();
    stopHeartbeat();
    client = null;
    summaryRuntime = null;
  });
}
