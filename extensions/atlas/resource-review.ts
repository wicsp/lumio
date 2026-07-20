import type { AtlasClient } from "./client";
import {
  configuredVaultPath,
  createKnowledgeCommentDraft,
  projectResourceCard,
  readCompletedKnowledgeComment,
  type AtlasResourceRecord,
  type AtlasSourceRecord,
  type KnowledgeCommentDraft,
  type ResourceCardProjection,
} from "./obsidian";
import type { ArtifactRef, HandlerResult, RunRecord } from "./work";

export interface AtlasResourceBundle {
  resource: AtlasResourceRecord;
  source: AtlasSourceRecord;
  artifact: ArtifactRef;
}

export interface ResourceCommentResult {
  resource: AtlasResourceRecord;
  source: AtlasSourceRecord;
  draft: KnowledgeCommentDraft;
  projection: ResourceCardProjection | null;
}

export class ResourceCommentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ResourceCommentError";
  }
}

type ReviewClient = Pick<AtlasClient, "controlGet" | "controlPost" | "controlPatch">;

interface CommentCompleteResponse {
  resource: AtlasResourceRecord;
  knowledge_ref: {
    knowledge_ref_id: string;
    note_id: string;
    uri: string;
    source_ids: string[];
    resource_ids: string[];
  };
  comment: AtlasCommentRecord;
}

export interface AtlasCommentRecord {
  comment_id: string;
  knowledge_ref_id: string;
  note_id: string;
  source_ids: string[];
  resource_ids: string[];
  body_markdown: string;
  content_hash: string;
  format: "text/markdown";
  created_at: string;
  updated_at: string;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ResourceCommentError("cancelled", "Comment setup was cancelled", false);
  }
}

function atlasError(
  operation: string,
  failure: { status: number; error: string },
  notFoundCode = "atlas_record_not_found",
): ResourceCommentError {
  const retryable = failure.status === 0 || failure.status >= 500;
  const code = failure.status === 404
    ? notFoundCode
    : failure.status === 401 || failure.status === 403
      ? "atlas_auth_rejected"
      : retryable
        ? "atlas_unavailable"
        : "atlas_request_rejected";
  return new ResourceCommentError(
    code,
    `${operation} failed: ${failure.error.slice(0, 240)}`,
    retryable,
  );
}

export async function fetchResourceBundle(
  client: Pick<AtlasClient, "controlGet">,
  resourceId: string,
): Promise<AtlasResourceBundle> {
  const response = await client.controlGet<AtlasResourceBundle>(
    `/api/resources/${encodeURIComponent(resourceId)}/bundle`,
  );
  if (!response.ok) {
    throw atlasError("Resource bundle lookup", response, "resource_not_found");
  }
  return response.data;
}

export async function projectResourceBundle(
  bundle: AtlasResourceBundle,
  vaultPath = configuredVaultPath(),
): Promise<ResourceCardProjection | null> {
  if (!vaultPath || !["summary", "comparison"].includes(bundle.resource.kind)) return null;
  return projectResourceCard(vaultPath, {
    ...bundle.resource,
    artifact_uri: bundle.artifact.uri,
    source_uri: bundle.source.canonical_uri,
  });
}

/**
 * Create only the local human-owned draft. The Resource deliberately remains
 * pending until completeResourceComment is called by an explicit human action.
 *
 * Draft creation is idempotent and never overwrites existing human prose.
 */
export async function createResourceComment(
  client: ReviewClient,
  resourceId: string,
  options: { vaultPath?: string; signal?: AbortSignal } = {},
): Promise<ResourceCommentResult> {
  if (!/^res_[A-Za-z0-9._-]{8,120}$/.test(resourceId)) {
    throw new ResourceCommentError("invalid_input", "Invalid Resource ID", false);
  }
  const vaultPath = options.vaultPath ?? configuredVaultPath();
  if (!vaultPath) {
    throw new ResourceCommentError(
      "vault_unconfigured",
      "ATLAS_OBSIDIAN_VAULT is not configured",
      false,
    );
  }

  checkAbort(options.signal);
  const bundle = await fetchResourceBundle(client, resourceId);
  if (bundle.resource.kind !== "summary") {
    throw new ResourceCommentError(
      "unsupported_resource",
      "Human comment setup currently requires a summary Resource",
      false,
    );
  }

  checkAbort(options.signal);
  let draft: KnowledgeCommentDraft;
  try {
    draft = await createKnowledgeCommentDraft(vaultPath, bundle.resource);
  } catch {
    throw new ResourceCommentError(
      "comment_file_failed",
      "Unable to create or preserve the blank Knowledge Comment",
      true,
    );
  }

  checkAbort(options.signal);
  let projection: ResourceCardProjection | null;
  try {
    projection = await projectResourceBundle(bundle, vaultPath);
  } catch {
    throw new ResourceCommentError(
      "card_projection_failed",
      "Comment draft was created, but Resource Card projection failed",
      true,
    );
  }

  return {
    resource: bundle.resource,
    source: bundle.source,
    draft,
    projection,
  };
}

/** Upload the completed local Markdown; Atlas atomically stores it and marks reviewed. */
export async function completeResourceComment(
  client: ReviewClient,
  resourceId: string,
  vaultPath = configuredVaultPath(),
): Promise<{ resource: AtlasResourceRecord; comment: AtlasCommentRecord; projection: ResourceCardProjection | null }> {
  if (!/^res_[A-Za-z0-9._-]{8,120}$/.test(resourceId)) {
    throw new ResourceCommentError("invalid_input", "Invalid Resource ID", false);
  }
  if (!vaultPath) {
    throw new ResourceCommentError("vault_unconfigured", "ATLAS_OBSIDIAN_VAULT is not configured", false);
  }
  let localComment;
  try {
    localComment = await readCompletedKnowledgeComment(vaultPath, resourceId);
  } catch (error) {
    throw new ResourceCommentError(
      "comment_not_ready",
      error instanceof Error ? error.message : "Unable to read completed Knowledge Comment",
      false,
    );
  }
  const completed = await client.controlPost<CommentCompleteResponse>(
    "/api/review-actions/complete-comment",
    {
      resource_id: resourceId,
      body_markdown: localComment.body_markdown,
      content_hash: localComment.content_hash,
    },
  );
  if (!completed.ok) throw atlasError("Comment completion", completed, "resource_not_found");
  const bundle = await fetchResourceBundle(client, resourceId);
  const projection = await projectResourceBundle(
    { ...bundle, resource: completed.data.resource },
    vaultPath,
  );
  return { resource: completed.data.resource, comment: completed.data.comment, projection };
}

export async function vortexCommentSyncHandler(
  run: RunRecord,
  _signal: AbortSignal,
  client: ReviewClient,
): Promise<HandlerResult> {
  const resourceId = typeof run.input.resource_id === "string" ? run.input.resource_id.trim() : "";
  if (!resourceId) {
    return { status: "failure", code: "invalid_input", message: "Missing required field: resource_id", retryable: false };
  }
  try {
    const result = await completeResourceComment(client, resourceId);
    return {
      status: "success",
      output: {
        resource_id: result.resource.resource_id,
        review_status: result.resource.review_status,
        comment_id: result.comment.comment_id,
        content_hash: result.comment.content_hash,
        card_projection: result.projection?.action ?? null,
      },
      artifacts: [],
      source_updates: [],
      resources: [],
    };
  } catch (error) {
    if (error instanceof ResourceCommentError) {
      return { status: "failure", code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      status: "failure",
      code: "comment_sync_failed",
      message: error instanceof Error ? error.message.slice(0, 240) : "Comment sync failed",
      retryable: true,
    };
  }
}

export async function vortexCommentHandler(
  run: RunRecord,
  signal: AbortSignal,
  client: ReviewClient,
): Promise<HandlerResult> {
  const resourceId = run.input.resource_id;
  if (typeof resourceId !== "string" || !resourceId.trim()) {
    return {
      status: "failure",
      code: "invalid_input",
      message: "Missing required field: resource_id",
      retryable: false,
    };
  }

  try {
    const result = await createResourceComment(client, resourceId.trim(), { signal });
    return {
      status: "success",
      output: {
        resource_id: result.resource.resource_id,
        source_id: result.source.source_id,
        review_status: "pending",
        note_id: result.draft.note_id,
        note_uri: result.draft.uri,
        note_created: result.draft.created,
        card_projection: result.projection?.action ?? null,
      },
      artifacts: [],
      source_updates: [],
      resources: [],
    };
  } catch (error) {
    if (error instanceof ResourceCommentError) {
      return {
        status: "failure",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };
    }
    return {
      status: "failure",
      code: "comment_setup_failed",
      message: "Unexpected failure while setting up the Knowledge Comment",
      retryable: true,
    };
  }
}
