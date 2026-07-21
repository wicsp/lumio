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
import type { ArtifactRef } from "./contracts";

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
