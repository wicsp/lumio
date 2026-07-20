import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AtlasClient } from "./client";
import type { AtlasSourceRecord } from "./obsidian";
import type { RunRecord } from "./work";
import { storeTextArtifact } from "./artifacts";

export const DEFAULT_WEB_CAPTURE_PORT = 43_119;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MIN_MARKDOWN_CHARS = 20;

export interface WebCapturePayload {
  url: string;
  title: string;
  markdown: string;
  captured_at?: string;
}

export interface WebCaptureResult {
  source_id: string;
  run_id: string;
}

export interface WebCaptureServer {
  port: number;
  close(): Promise<void>;
}

export function webCaptureNodeCapability(nodeId: string): string {
  return `web-capture-node:${nodeId}`;
}

function capturePort(): number {
  const configured = Number.parseInt(process.env.LUMIO_WEB_CAPTURE_PORT ?? "", 10);
  return Number.isInteger(configured) && configured > 0 && configured < 65_536
    ? configured
    : DEFAULT_WEB_CAPTURE_PORT;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http or https");
  url.hash = "";
  return url.href;
}

function validatePayload(value: unknown): Required<WebCapturePayload> {
  if (!value || typeof value !== "object") throw new Error("Invalid capture payload");
  const payload = value as Record<string, unknown>;
  const url = canonicalUrl(String(payload.url ?? ""));
  const title = String(payload.title ?? "").trim().slice(0, 1000);
  const markdown = String(payload.markdown ?? "").trim();
  if (!title) throw new Error("Page title is empty");
  if (markdown.length < MIN_MARKDOWN_CHARS) throw new Error("Page extraction is empty or too short");
  if (Buffer.byteLength(markdown, "utf-8") > MAX_REQUEST_BYTES) throw new Error("Page extraction exceeds 2 MiB");
  const captured = typeof payload.captured_at === "string" ? new Date(payload.captured_at) : new Date();
  if (Number.isNaN(captured.getTime())) throw new Error("Invalid capture timestamp");
  return { url, title, markdown, captured_at: captured.toISOString() };
}

export async function captureWebPage(
  client: AtlasClient,
  rawPayload: unknown,
): Promise<WebCaptureResult> {
  const payload = validatePayload(rawPayload);
  const pageId = createHash("sha256").update(payload.url).digest("hex").slice(0, 24);
  const markdown = `${payload.markdown}\n`;
  const extraction = storeTextArtifact(
    markdown,
    "extractions/web",
    pageId,
    `extraction-${pageId}`,
    ".md",
    "text/markdown; charset=utf-8",
  );

  const source = await client.controlPost<AtlasSourceRecord>("/api/sources", {
    source_key: `web:${createHash("sha256").update(payload.url).digest("hex")}`,
    kind: "webpage",
    canonical_uri: payload.url,
    title: payload.title,
    external_ids: {},
    metadata: { captured_via: "lumio-web-clipper", captured_at: payload.captured_at },
  });
  if (!source.ok) throw new Error(`Atlas Source capture failed: ${source.error}`);

  const project = await client.controlPost("/api/projects", {
    project_id: "web-capture",
    name: "Web Capture",
    description: "Pages captured by the Lumio Chrome extension.",
  });
  if (!project.ok) throw new Error(`Atlas project setup failed: ${project.error}`);

  const enqueued = await client.controlPost<RunRecord>("/api/runs/enqueue", {
    project_id: "web-capture",
    job_name: "web-summary-v1",
    capabilities_required: ["web-summary-v1", webCaptureNodeCapability(client.config.nodeId)],
    input: {
      source_id: source.data.source_id,
      url: payload.url,
      title: payload.title,
      captured_at: payload.captured_at,
      extraction,
    },
    priority: 5,
    metadata: { requested_via: "lumio-web-clipper" },
  });
  if (!enqueued.ok) throw new Error(`Atlas enqueue failed: ${enqueued.error}`);
  return { source_id: source.data.source_id, run_id: enqueued.data.run_id };
}

function isExtensionOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function sendJson(response: ServerResponse, status: number, body: unknown, origin?: string) {
  if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new Error("Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request exceeds 2 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export async function startWebCaptureServer(
  getClient: () => AtlasClient | null,
  options: { port?: number } = {},
): Promise<WebCaptureServer | null> {
  const port = options.port ?? capturePort();
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin ?? "";
    if (!isExtensionOrigin(request)) {
      sendJson(response, 403, { ok: false, error: "Chrome extension origin required" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Lumio-Capture",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/capture") {
      sendJson(response, 404, { ok: false, error: "Not found" }, origin);
      return;
    }
    if (request.headers["x-lumio-capture"] !== "1") {
      sendJson(response, 403, { ok: false, error: "Missing capture header" }, origin);
      return;
    }
    const client = getClient();
    if (!client) {
      sendJson(response, 503, { ok: false, error: "Atlas is not connected" }, origin);
      return;
    }
    try {
      const result = await captureWebPage(client, await readJson(request));
      sendJson(response, 202, { ok: true, ...result }, origin);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, origin);
    }
  });

  return await new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
