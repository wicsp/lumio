/**
 * Atlas Connected Lumio Agent — RFC 0001 + M2.5 Execution Hardening.
 *
 * Registers user-facing Atlas commands for manual use within Pi/Lumio sessions.
 * Does NOT register as an Atlas Runner or run background workflows; all
 * background execution is handled by AtlasRunner.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseConfig,
  createClient,
  type AtlasClient,
  type AtlasClientStatus,
} from "./client";
import {
  configuredVaultPath,
  ensureVaultStructure,
  removeResourceCard,
  type ResourceCardProjection,
  type ResourceCardRemoval,
  type AtlasResourceRecord,
  type AtlasSourceRecord,
} from "./obsidian";
import {
  fetchResourceBundle,
  projectResourceBundle,
  type AtlasResourceBundle,
} from "./resource-review";
import { generateDailyReviewDigest, generateWeeklyAudit } from "./digests";
import { requestPaperPreview } from "./paper-preview";

// ─── Module state ────────────────────────────────────────────────────

let client: AtlasClient | null = null;

// ─── Reconciliation ──────────────────────────────────────────────────

export interface ResourceCardReconciliation {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

interface AtlasKnowledgeRefRecord {
  resource_ids: string[];
}

interface AtlasResourceIgnoreResponse {
  resource: AtlasResourceRecord;
  evicted_resource_ids: string[];
}

function resourceProfileId(resource: AtlasResourceRecord): string {
  const declared = resource.metadata.profile_id;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  const generator = resource.generator;
  return [
    resource.kind,
    generator.name,
    generator.version,
    generator.model_provider ?? "deterministic",
    generator.model_id ?? "deterministic",
    generator.prompt_version ?? "deterministic",
  ].join(":");
}

/** Make the rebuildable Resource Card projection match Atlas' current review metadata. */
export async function reconcileResourceCards(
  c: Pick<AtlasClient, "controlGet">,
): Promise<ResourceCardReconciliation> {
  const vaultPath = configuredVaultPath();
  if (!vaultPath) throw new Error("ATLAS_OBSIDIAN_VAULT is not configured");
  await ensureVaultStructure(vaultPath);
  const [summaryResponse, comparisonResponse, knowledgeResponse] = await Promise.all([
    c.controlGet<AtlasResourceRecord[]>("/api/resources?kind=summary&limit=500"),
    c.controlGet<AtlasResourceRecord[]>("/api/resources?kind=comparison&limit=500"),
    c.controlGet<AtlasKnowledgeRefRecord[]>("/api/knowledge-refs?limit=500"),
  ]);
  if (!summaryResponse.ok) throw new Error(summaryResponse.error);
  if (!comparisonResponse.ok) throw new Error(comparisonResponse.error);
  if (!knowledgeResponse.ok) throw new Error(knowledgeResponse.error);
  const resources = [...summaryResponse.data, ...comparisonResponse.data];

  const referenced = new Set(knowledgeResponse.data.flatMap((item) => item.resource_ids));
  const currentBySlot = new Map<string, AtlasResourceRecord>();
  for (const resource of resources) {
    if (resource.review_status === "dismissed") continue;
    const slot = `${resource.source_id}\0${resourceProfileId(resource)}`;
    const current = currentBySlot.get(slot);
    if (!current || resource.created_at > current.created_at || (
      resource.created_at === current.created_at && resource.resource_id > current.resource_id
    )) {
      currentBySlot.set(slot, resource);
    }
  }
  const projected = new Set([
    ...[...currentBySlot.values()].map((resource) => resource.resource_id),
    ...referenced,
  ]);

  const result: ResourceCardReconciliation = {
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    failed: 0,
    errors: [],
  };
  let cursor = 0;
  const workerCount = Math.min(4, resources.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < resources.length) {
      const resource = resources[cursor++];
      try {
        if (resource.review_status === "dismissed" || !projected.has(resource.resource_id)) {
          const removal = await removeResourceCard(vaultPath, resource.resource_id);
          result[removal.removed ? "removed" : "unchanged"] += 1;
          continue;
        }
        const bundleResponse = await c.controlGet<AtlasResourceBundle>(
          `/api/resources/${encodeURIComponent(resource.resource_id)}/content`,
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

function formatStatus(status: AtlasClientStatus): string {
  if (status.kind === "disconnected") {
    return `Atlas: disconnected — ${status.reason}`;
  }
  return `Atlas: connected — ${status.health.version}, health ${status.health.status}`;
}

// ─── Extension entry point ───────────────────────────────────────────

export default function atlasExtension(pi: ExtensionAPI) {
  pi.registerCommand("atlas:paper-preview", {
    description: "Create an abstract-based preview for one arXiv paper",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /atlas:paper-preview <arXiv ID or URL>", "warning");
        return;
      }
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const result = await requestPaperPreview(client, args);
        ctx.ui.notify(
          result.preview_resource_id
            ? `Atlas: reused paper preview for ${result.arxiv_id} (${result.preview_resource_id}).`
            : `Atlas: started paper preview for ${result.arxiv_id} (${result.run_id}).`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Atlas paper preview failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

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

      const bvid = url.match(/BV[a-zA-Z0-9]{10}/)?.[0] ?? null;
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

        const enqueued = await client.controlPost<{
          invocation_id: string;
          step_runs: Record<string, string>;
        }>("/api/workflow-invocations", {
          workflow_name: "bilibili.summary",
          workflow_version: "5",
          input: {
            url,
            canonical_url: canonicalUrl,
            source_id: source.data.source_id,
          },
        });
        if (enqueued.ok) {
          ctx.ui.notify(
            `Atlas: captured ${bvid}; started workflow ${enqueued.data.invocation_id}.`,
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

  pi.registerCommand("atlas:ignore", {
    description: "Move one Atlas Resource (and its comment) into the 10-item ignore list",
    handler: async (args, ctx) => {
      const resourceId = args.trim();
      if (!resourceId) {
        ctx.ui.notify("Usage: /atlas:ignore <resource_id>", "warning");
        return;
      }
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const ignored = await client.controlPost<AtlasResourceIgnoreResponse>(
          "/api/review-actions/ignore-resource",
          { resource_id: resourceId },
        );
        if (!ignored.ok) {
          ctx.ui.notify(`Atlas ignore refused: ${ignored.error}`, "warning");
          return;
        }

        const vaultPath = configuredVaultPath();
        if (ignored.data.resource.kind === "summary" && vaultPath) {
          let removal: ResourceCardRemoval;
          try {
            removal = await removeResourceCard(vaultPath, resourceId);
          } catch (err) {
            ctx.ui.notify(
              `Atlas ignored ${resourceId}, but local card removal failed: ${err instanceof Error ? err.message : String(err)}. Reconciliation will retry it.`,
              "warning",
            );
            return;
          }
          const evicted = ignored.data.evicted_resource_ids.length;
          ctx.ui.notify(
            `Atlas: ignored ${resourceId}; Resource Card ${removal.removed ? "removed" : "was already absent"}${evicted ? `; ${evicted} oldest ignored item permanently cleaned` : ""}.`,
            "info",
          );
        } else {
          ctx.ui.notify(`Atlas: ignored ${resourceId}.`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Atlas ignore failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("atlas:undo-ignore", {
    description: "Undo ignore and restore the Resource's previous review state",
    handler: async (args, ctx) => {
      const resourceId = args.trim();
      if (!resourceId) {
        ctx.ui.notify("Usage: /atlas:undo-ignore <resource_id>", "warning");
        return;
      }
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const restored = await client.controlPost<AtlasResourceIgnoreResponse>(
          "/api/review-actions/restore-resource",
          { resource_id: resourceId },
        );
        if (!restored.ok) {
          ctx.ui.notify(`Atlas undo-ignore failed: ${restored.error}`, "warning");
          return;
        }

        let projection: ResourceCardProjection | null = null;
        if (restored.data.resource.kind === "summary" && configuredVaultPath()) {
          try {
            const bundle = await fetchResourceBundle(client, resourceId);
            projection = await projectResourceBundle({
              ...bundle,
              resource: restored.data.resource,
            });
          } catch (err) {
            ctx.ui.notify(
              `Atlas restored ${resourceId}, but card projection failed: ${err instanceof Error ? err.message : String(err)}. Reconciliation will retry it.`,
              "warning",
            );
            return;
          }
        }
        ctx.ui.notify(
          `Atlas: undo-ignore restored ${resourceId} to ${restored.data.resource.review_status}${projection ? `; Resource Card ${projection.action}` : ""}.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Atlas undo-ignore failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    },
  });

  pi.registerCommand("atlas:digest", {
    description: "Generate today's deterministic Atlas review digest in Vortex",
    handler: async (_args, ctx) => {
      const vaultPath = configuredVaultPath();
      if (!client || !vaultPath) {
        ctx.ui.notify("Atlas or ATLAS_OBSIDIAN_VAULT is not configured.", "warning");
        return;
      }
      try {
        const result = await generateDailyReviewDigest(client, vaultPath);
        ctx.ui.notify(`Atlas digest ${result.action}: ${result.relative_path}.`, "info");
      } catch (err) {
        ctx.ui.notify(`Atlas digest failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  pi.registerCommand("atlas:audit", {
    description: "Generate a deterministic weekly Atlas/Vortex integrity audit",
    handler: async (_args, ctx) => {
      const vaultPath = configuredVaultPath();
      if (!client || !vaultPath) {
        ctx.ui.notify("Atlas or ATLAS_OBSIDIAN_VAULT is not configured.", "warning");
        return;
      }
      try {
        const result = await generateWeeklyAudit(client, vaultPath);
        ctx.ui.notify(`Atlas audit ${result.action}: ${result.relative_path}.`, "info");
      } catch (err) {
        ctx.ui.notify(`Atlas audit failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  pi.registerCommand("atlas:compare", {
    description: "Enqueue an explicit friction comparison against written Knowledge Comments",
    handler: async (args, ctx) => {
      const resourceId = args.trim();
      if (!/^res_[A-Za-z0-9._-]{8,120}$/.test(resourceId)) {
        ctx.ui.notify("Usage: /atlas:compare <resource_id>", "warning");
        return;
      }
      if (!client) {
        ctx.ui.notify("Atlas is not connected.", "warning");
        return;
      }
      try {
        const enqueued = await client.controlPost<{ run: { run_id: string } }>(
          "/api/review-actions/compare",
          { resource_id: resourceId },
        );
        if (!enqueued.ok) throw new Error(enqueued.error);
        ctx.ui.notify(`Atlas comparison enqueued: ${enqueued.data.run.run_id}.`, "info");
      } catch (err) {
        ctx.ui.notify(`Atlas comparison failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  // ── /atlas command ─────────────────────────────────────────────
  pi.registerCommand("atlas", {
    description: "Show Atlas connection status",
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
          "Atlas configured but no active session agent. Use /atlas:enqueue, /atlas:reconcile etc. to interact.",
          "info",
        );
        return;
      }

      const status = await client.status();
      const msg = formatStatus(status);
      ctx.ui.notify(msg, status.kind === "connected" ? "info" : "warning");
    },
  });

  // ── Session lifecycle ─────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Clean up any previous session's resources.
    client = null;

    const config = parseConfig();
    if (!config) return;

    client = createClient(config);
    const vaultPath = configuredVaultPath();
    if (vaultPath) {
      try {
        await ensureVaultStructure(vaultPath);
        const health = await client.health();
        if (health.ok) {
          const result = await reconcileResourceCards(client);
          await generateDailyReviewDigest(client, vaultPath);
          if (new Date().getDay() === 0) {
            await generateWeeklyAudit(client, vaultPath);
          }
          if (result.failed > 0 && ctx.hasUI) {
            ctx.ui.notify(
              `Atlas Vortex reconciliation: ${formatReconciliation(result)}`,
              "warning",
            );
          }
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Atlas Vortex startup sync failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    client = null;
  });
}
