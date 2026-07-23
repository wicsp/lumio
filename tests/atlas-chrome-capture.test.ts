import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../chrome-extension/atlas-capture/", import.meta.url);

test("toolbar click immediately captures while the popup reports status", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf-8"));
  const html = readFileSync(new URL("popup.html", root), "utf-8");
  const script = readFileSync(new URL("popup.js", root), "utf-8");

  assert.equal(manifest.action.default_popup, "popup.html");
  assert.match(script, /void sendCurrentPage\(\)/);
  assert.doesNotMatch(html, /id="send"/);
  assert.match(html, /role="status"/);
  assert.match(html, /id="result"/);
  assert.match(script, /payload\.source_id/);
  assert.match(script, /payload\.run_id/);
  assert.match(script, /waitForRun\(payload\.run_id\)/);
  assert.match(script, /"X-Lumio-Capture": "1"/);
  assert.match(script, /payload\.status === "completed"/);
  assert.match(html, /id="run-state"/);
  assert.match(html, /id="run-result"/);
  assert.match(script, /AtlasRunner capture bridge is unavailable/);
});
