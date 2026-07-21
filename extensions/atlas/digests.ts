import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AtlasClient } from "./client";
import type { AtlasResourceRecord, AtlasSourceRecord } from "./obsidian";
import type { RunRecord } from "./contracts";

interface KnowledgeRefRecord {
  note_id: string;
  resource_ids: string[];
}

interface ReviewSnapshot {
  sources: AtlasSourceRecord[];
  resources: AtlasResourceRecord[];
  knowledgeRefs: KnowledgeRefRecord[];
  runs: RunRecord[];
}

export interface DigestWriteResult {
  relative_path: string;
  action: "created" | "updated" | "unchanged";
}

function profileId(resource: AtlasResourceRecord): string {
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

async function snapshot(client: Pick<AtlasClient, "controlGet">): Promise<ReviewSnapshot> {
  const [sources, resources, knowledgeRefs, runs] = await Promise.all([
    client.controlGet<AtlasSourceRecord[]>("/api/sources?limit=500"),
    client.controlGet<AtlasResourceRecord[]>("/api/resources?kind=summary&limit=500"),
    client.controlGet<KnowledgeRefRecord[]>("/api/knowledge-refs?limit=500"),
    client.controlGet<RunRecord[]>("/api/runs?limit=500"),
  ]);
  for (const response of [sources, resources, knowledgeRefs, runs]) {
    if (!response.ok) throw new Error(response.error);
  }
  return {
    sources: sources.ok ? sources.data : [],
    resources: resources.ok ? resources.data : [],
    knowledgeRefs: knowledgeRefs.ok ? knowledgeRefs.data : [],
    runs: runs.ok ? runs.data : [],
  };
}

function currentResources(resources: AtlasResourceRecord[]): AtlasResourceRecord[] {
  const current = new Map<string, AtlasResourceRecord>();
  for (const resource of resources) {
    if (resource.review_status === "dismissed") continue;
    const key = `${resource.source_id}\0${profileId(resource)}`;
    const previous = current.get(key);
    if (!previous || resource.created_at > previous.created_at || (
      resource.created_at === previous.created_at && resource.resource_id > previous.resource_id
    )) current.set(key, resource);
  }
  return [...current.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function titleFor(resource: AtlasResourceRecord, sources: Map<string, AtlasSourceRecord>): string {
  return sources.get(resource.source_id)?.title || resource.title;
}

async function commentState(vaultPath: string, noteId: string): Promise<"missing" | "blank" | "written"> {
  const path = join(vaultPath, `${noteId}.md`);
  if (!existsSync(path)) return "missing";
  const content = await readFile(path, "utf-8");
  const section = content.match(/## 我的评论\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
  const prose = section.replace(/<!--[\s\S]*?-->/g, "").trim();
  return prose ? "written" : "blank";
}

async function localDraftIds(vaultPath: string): Promise<string[]> {
  const directory = join(vaultPath, "Knowledge", "Comments");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^res_[A-Za-z0-9._-]{8,120}\.md$/.test(name))
    .map((name) => name.replace(/\.md$/, ""));
}

export async function generateDailyReviewDigest(
  client: Pick<AtlasClient, "controlGet">,
  vaultPath: string,
  date = new Date().toISOString().slice(0, 10),
): Promise<DigestWriteResult> {
  const data = await snapshot(client);
  const sources = new Map(data.sources.map((source) => [source.source_id, source]));
  const current = currentResources(data.resources);
  const referenced = new Set(data.knowledgeRefs.flatMap((item) => item.resource_ids));
  const pending = current.filter((item) => item.review_status === "pending");
  const drafts = (await localDraftIds(vaultPath)).filter((id) => !referenced.has(id));
  const failed = data.runs.filter((run) => run.status === "failed" || run.status === "cancelled");
  const lines = [
    "---",
    "type: atlas-daily-digest",
    "generated: true",
    `date: ${JSON.stringify(date)}`,
    "---",
    "",
    `# Atlas Daily Digest — ${date}`,
    "",
    `- 当前待判断：${pending.length}`,
    `- 本地未完成草稿：${drafts.length}`,
    `- 失败或取消 Run：${failed.length}`,
    "",
    "## 待判断",
    "",
    ...(pending.length ? pending.map((resource) =>
      `- [[Resources/Cards/${resource.resource_id}|${titleFor(resource, sources)}]] · \`${profileId(resource)}\``
    ) : ["- 无"]),
    "",
    "## 未完成评论草稿",
    "",
    ...(drafts.length ? drafts.map((id) =>
      `- [[Knowledge/Comments/${id}|${id}]] · [[Resources/Cards/${id}|Resource]]`
    ) : ["- 无"]),
    "",
    "## 失败或取消的 Run",
    "",
    ...(failed.length ? failed.slice(0, 20).map((run) =>
      `- \`${run.run_id}\` · ${run.job_name} · ${run.error_message ?? run.status}`
    ) : ["- 无"]),
    "",
  ];
  return writeGenerated(vaultPath, `Resources/Digests/Daily Papers/${date}.md`, lines.join("\n"));
}

export async function generateWeeklyAudit(
  client: Pick<AtlasClient, "controlGet">,
  vaultPath: string,
  date = new Date().toISOString().slice(0, 10),
): Promise<DigestWriteResult> {
  const data = await snapshot(client);
  const issues: string[] = [];
  const referenced = new Set(data.knowledgeRefs.flatMap((item) => item.resource_ids));
  const slots = new Map<string, AtlasResourceRecord[]>();
  for (const resource of data.resources.filter((item) => item.review_status !== "dismissed")) {
    const key = `${resource.source_id}\0${profileId(resource)}`;
    slots.set(key, [...(slots.get(key) ?? []), resource]);
  }
  for (const [key, resources] of slots) {
    const unreferenced = resources.filter((resource) => !referenced.has(resource.resource_id));
    if (unreferenced.length > 1) issues.push(`重复分析槽：\`${key.replace("\0", " / ")}\` 有 ${unreferenced.length} 个未引用版本`);
  }
  for (const reference of data.knowledgeRefs) {
    const state = await commentState(vaultPath, reference.note_id);
    if (state !== "written") issues.push(`KnowledgeRef \`${reference.note_id}\`：${state === "missing" ? "本地文件缺失" : "评论仍为空"}`);
  }
  for (const resource of data.resources) {
    if (resource.review_status === "reviewed" && !referenced.has(resource.resource_id)) {
      issues.push(`Resource \`${resource.resource_id}\` 已 reviewed，但没有 KnowledgeRef`);
    }
  }
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1_000;
  for (const resource of currentResources(data.resources)) {
    if (resource.review_status === "pending" && Date.parse(resource.created_at) < cutoff) {
      issues.push(`Resource \`${resource.resource_id}\` pending 超过 14 天`);
    }
  }
  const content = [
    "---",
    "type: atlas-weekly-audit",
    "generated: true",
    `date: ${JSON.stringify(date)}`,
    "---",
    "",
    `# Atlas Weekly Audit — ${date}`,
    "",
    ...(issues.length ? issues.map((issue) => `- ${issue}`) : ["- 未发现状态或引用异常。"]),
    "",
  ].join("\n");
  return writeGenerated(vaultPath, `Resources/Digests/Audits/${date}.md`, content);
}

async function writeGenerated(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<DigestWriteResult> {
  const destination = join(vaultPath, ...relativePath.split("/"));
  const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
  const action = await withFileMutationQueue(destination, async () => {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let current: string | null = null;
    try { current = await readFile(destination, "utf-8"); } catch { /* absent */ }
    if (current === content) return "unchanged" as const;
    const nextAction = current === null ? "created" as const : "updated" as const;
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } finally {
      try { await unlink(temporary); } catch { /* renamed or absent */ }
    }
    return nextAction;
  });
  return { relative_path: relativePath, action };
}
