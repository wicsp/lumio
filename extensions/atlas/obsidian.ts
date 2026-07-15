import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface AtlasSourceRecord {
  source_id: string;
  source_key: string;
  kind: string;
  canonical_uri: string;
  title: string | null;
  external_ids: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AtlasResourceRecord {
  resource_id: string;
  source_id: string;
  produced_by_run_id: string;
  artifact_id: string;
  kind: "transcript" | "summary" | "extraction" | "comparison";
  title: string;
  content_hash: string;
  generator: {
    mode: "deterministic" | "ai";
    name: string;
    version: string;
    model_provider?: string;
    model_id?: string;
    prompt_version?: string;
  };
  metadata: Record<string, unknown>;
  review_status: "pending" | "reviewed" | "dismissed";
  created_at: string;
  updated_at: string;
}

export interface ProjectableResource extends AtlasResourceRecord {
  artifact_uri: string;
  source_uri: string;
}

export type ResourceCardProjectionAction = "created" | "updated" | "unchanged";

export interface ResourceCardProjection {
  relative_path: string;
  action: ResourceCardProjectionAction;
}

export interface ResourceCardRemoval {
  relative_path: string;
  removed: boolean;
}

const REQUIRED_DIRECTORIES = [
  "Knowledge/Inbox",
  "Knowledge/Comments",
  "Knowledge/Maps",
  "Knowledge/Attachments",
  "Resources/Cards",
  "Resources/Digests/Daily Papers",
  "Resources/Digests/News",
  "System/Templates",
];

export function configuredVaultPath(): string | null {
  return process.env.ATLAS_OBSIDIAN_VAULT?.trim() || null;
}

/** Create only structure and policy files; never migrate or modify the old Vortex vault. */
export async function ensureVaultStructure(vaultPath: string): Promise<void> {
  await Promise.all(REQUIRED_DIRECTORIES.map((path) => (
    mkdir(join(vaultPath, path), { recursive: true, mode: 0o700 })
  )));

  await writeIfMissing(join(vaultPath, "System", "Policy.md"), `# Knowledge boundary

- \`Knowledge/**\` contains human-authored comments, revisions, and maps.
- \`Resources/**\` contains machine-generated or mechanically derived material and can be rebuilt.
- AI may create an empty Knowledge Comment template only after an explicit user command.
- AI must never generate, complete, rewrite, or silently promote prose in \`Knowledge/**\`.
- Atlas stores Source, Resource, Run, and KnowledgeRef metadata; artifact bytes stay outside SQLite.
- Zotero remains authoritative for bibliography and PDFs.
`);

  await writeIfMissing(join(vaultPath, "System", "Templates", "Knowledge Comment.md"), `---
type: knowledge-comment
resource_ids: []
source_ids: []
created:
---

# Knowledge Comment

## 我的评论

<!-- 这里只写你自己负责的内容。 -->

## 证据定位

<!-- 记录页码、时间戳、实验 Run 或原文位置。 -->

## 修订关系

<!-- 如果观点发生变化，链接到旧评论并说明变化。 -->
`);

  await writeIfMissing(join(vaultPath, "Home.md"), `# Vortex

- [[System/Policy|Knowledge boundary]]
- Human work: \`Knowledge/\`
- Machine-generated review material: \`Resources/\`

此库从空结构开始；Vortexbackup 仅作为备份和按需参考，不做批量迁移。
`);
}

/** Rebuild one machine-owned Resource Card from its canonical external artifact. */
export async function projectResourceCard(
  vaultPath: string,
  resource: ProjectableResource,
): Promise<ResourceCardProjection> {
  if (!resource.artifact_uri.startsWith("file://")) {
    throw new Error(`Unsupported artifact URI: ${resource.artifact_uri.slice(0, 80)}`);
  }
  const artifactPath = fileURLToPath(resource.artifact_uri);
  const artifactRoot = process.env.ATLAS_ARTIFACT_ROOT?.trim();
  if (artifactRoot && !isWithin(resolve(artifactRoot), resolve(artifactPath))) {
    throw new Error(`Artifact is outside ATLAS_ARTIFACT_ROOT: ${resource.resource_id}`);
  }
  const body = await readFile(artifactPath, "utf-8");
  const actualHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (actualHash !== resource.content_hash) {
    throw new Error(`Artifact checksum mismatch for ${resource.resource_id}`);
  }

  await ensureVaultStructure(vaultPath);
  const relativePath = resourceCardRelativePath(resource.resource_id);
  const destination = join(vaultPath, ...relativePath.split("/"));
  const generator = resource.generator.mode === "ai"
    ? `${resource.generator.name}@${resource.generator.version} (${resource.generator.model_provider}/${resource.generator.model_id}, ${resource.generator.prompt_version})`
    : `${resource.generator.name}@${resource.generator.version}`;
  const card = `---
type: resource
generated: true
resource_id: ${yamlString(resource.resource_id)}
source_id: ${yamlString(resource.source_id)}
run_id: ${yamlString(resource.produced_by_run_id)}
resource_kind: ${yamlString(resource.kind)}
review_status: ${yamlString(resource.review_status)}
content_hash: ${yamlString(resource.content_hash)}
artifact_uri: ${yamlString(resource.artifact_uri)}
source_uri: ${yamlString(resource.source_uri)}
generator: ${yamlString(generator)}
created_at: ${yamlString(resource.created_at)}
tags:
  - resource
  - ai-generated
---

> [!warning] Machine-generated Resource
> 这是可重建的前期调研材料，不是你的知识、观点或结论。请查看原始来源后，在独立的 Knowledge Comment 中写自己的内容。

# ${markdownTitle(resource.title)}

${body.trim()}

---

- [原始来源](${markdownUrl(resource.source_uri)})
- Resource ID: \`${resource.resource_id}\`
- Source ID: \`${resource.source_id}\`
- Run ID: \`${resource.produced_by_run_id}\`
`;
  const action = await atomicWriteIfChanged(destination, card);
  return { relative_path: relativePath, action };
}

/** Remove only the rebuildable Resource Card; never touch Knowledge notes or artifacts. */
export async function removeResourceCard(
  vaultPath: string,
  resourceId: string,
): Promise<ResourceCardRemoval> {
  const relativePath = resourceCardRelativePath(resourceId);
  const destination = join(vaultPath, ...relativePath.split("/"));
  const removed = await withMutationQueue(destination, async () => {
    try {
      await unlink(destination);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  });
  return { relative_path: relativePath, removed };
}

export interface KnowledgeCommentDraft {
  absolute_path: string;
  relative_path: string;
  note_id: string;
  uri: string;
  created: boolean;
}

/** Create a blank, human-owned comment note. Existing notes are never overwritten. */
export async function createKnowledgeCommentDraft(
  vaultPath: string,
  resource: AtlasResourceRecord,
): Promise<KnowledgeCommentDraft> {
  await ensureVaultStructure(vaultPath);
  const date = new Date().toISOString().slice(0, 10);
  const relativePath = `Knowledge/Comments/${date}-${resource.resource_id}.md`;
  const absolutePath = join(vaultPath, ...relativePath.split("/"));
  const noteId = relativePath.replace(/\.md$/, "");
  const uri = obsidianUri(vaultPath, noteId);
  let created = false;

  await withMutationQueue(absolutePath, async () => {
    if (existsSync(absolutePath)) return;
    const content = `---
type: knowledge-comment
resource_ids:
  - ${yamlString(resource.resource_id)}
source_ids:
  - ${yamlString(resource.source_id)}
created: ${yamlString(new Date().toISOString())}
---

# Knowledge Comment

## 我的评论

<!-- 从这里开始只写你自己负责的内容。 -->

## 证据定位

- Resource: [[Resources/Cards/${resource.resource_id}|${resource.resource_id}]]
<!-- 补充原视频时间戳、论文页码、实验 Run 或其他原始证据。 -->

## 修订关系

<!-- 如果观点发生变化，链接到旧评论并说明变化。 -->
`;
    await writeFile(absolutePath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    created = true;
  });

  return { absolute_path: absolutePath, relative_path: relativePath, note_id: noteId, uri, created };
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  await withMutationQueue(path, async () => {
    if (existsSync(path)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  });
}

async function atomicWriteIfChanged(
  path: string,
  content: string,
): Promise<ResourceCardProjectionAction> {
  return withMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let current: string | null = null;
    try {
      current = await readFile(path, "utf-8");
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    if (current === content) return "unchanged";

    const action: ResourceCardProjectionAction = current === null ? "created" : "updated";
    const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      await rename(tempPath, path);
    } finally {
      try { await unlink(tempPath); } catch { /* renamed or absent */ }
    }
    return action;
  });
}

async function withMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  // Dynamic ESM import keeps Lumio's standalone tsx tests compatible with Pi's
  // import-only package export while still using Pi's required mutation queue.
  const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
  return withFileMutationQueue(path, fn);
}

function obsidianUri(vaultPath: string, noteId: string): string {
  const params = new URLSearchParams({
    vault: basename(vaultPath),
    file: noteId,
  });
  return `obsidian://open?${params.toString()}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function resourceCardRelativePath(resourceId: string): string {
  if (!/^res_[A-Za-z0-9._-]{8,120}$/.test(resourceId)) {
    throw new Error(`Invalid Resource ID: ${resourceId.slice(0, 128)}`);
  }
  return `Resources/Cards/${resourceId}.md`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function markdownTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim() || "Untitled Resource";
}

function markdownUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported Source URI protocol: ${url.protocol}`);
  }
  return `<${url.toString()}>`;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

/** Useful in diagnostics without exposing the full home path. */
export function vaultRelativePath(vaultPath: string, filePath: string): string {
  return relative(vaultPath, filePath).split(sep).join("/");
}
