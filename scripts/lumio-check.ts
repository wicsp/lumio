/**
 * Lumio compatibility and upstream check script.
 *
 * Two checks:
 *   1. Pi version compatibility — when pi updates past the bound version,
 *      parse the pi CHANGELOG for breaking changes and cross-reference
 *      Lumio's source code against removed/changed APIs.
 *   2. Upstream monitoring — check referenced third-party extension repos
 *      for new commits since last check, report what changed.
 *
 * Usage: npx tsx scripts/lumio-check.ts
 *        npm run check
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

// ── Paths ──────────────────────────────────────────────────────────
const REPO_ROOT = resolve(import.meta.dirname, "..");
const PI_VERSION_PATH = join(REPO_ROOT, "pi-version.json");
const UPSTREAMS_PATH = join(REPO_ROOT, "upstreams.json");

// ── Types ──────────────────────────────────────────────────────────
interface PiVersionFile {
  piVersion: string;
  lastChecked: string;
  comment?: string;
}

interface UpstreamSource {
  id: string;
  type: "github";
  repo: string;
  reason: string;
  files: string[];
  lastCheckedRef: string | null;
}

interface UpstreamsFile {
  comment?: string;
  sources: UpstreamSource[];
}

interface BreakingChange {
  version: string;
  summary: string;
  details: string[];
}

interface CompatibilityIssue {
  severity: "high" | "medium" | "low";
  message: string;
  api: string;
  files: string[];
}

interface UpstreamUpdate {
  source: UpstreamSource;
  newRef: string;
  newDate: string;
  subject: string;
  commitCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function cmd(command: string, opts?: { cwd?: string }): string {
  try {
    return execSync(command, {
      cwd: opts?.cwd ?? REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function getCurrentPiVersion(): string {
  // Try global npm first
  const npmVer = cmd("npm list -g @earendil-works/pi-coding-agent --depth=0 2>/dev/null");
  const match = npmVer.match(/@earendil-works\/pi-coding-agent@(\d+\.\d+\.\d+)/);
  if (match) return match[1];

  // Fallback: try running pi --version
  const piVer = cmd("pi --version 2>/dev/null");
  if (piVer) return piVer.trim();

  return "unknown";
}

function getChangelogPath(): string {
  const npmRoot = cmd("npm root -g").trim();
  return join(npmRoot, "@earendil-works/pi-coding-agent/CHANGELOG.md");
}

function parseSemver(version: string): [number, number, number] {
  const parts = version.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function versionGte(a: string, b: string): boolean {
  const [a0, a1, a2] = parseSemver(a);
  const [b0, b1, b2] = parseSemver(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 >= b2;
}

function findSourceFiles(root: string, pattern: string): string[] {
  const result = cmd(`grep -rl "${pattern}" ${root}/extensions --include='*.ts' 2>/dev/null`);
  return result ? result.split("\n").map((f) => f.replace(root + "/", "")) : [];
}

// ── Pi compatibility check ─────────────────────────────────────────

/**
 * Parse the pi CHANGELOG and extract breaking changes between two versions.
 */
function extractBreakingChanges(
  changelogPath: string,
  boundVersion: string,
  currentVersion: string,
): BreakingChange[] {
  if (!existsSync(changelogPath)) {
    console.warn(`  ⚠ Changelog not found at ${changelogPath}`);
    return [];
  }

  const content = readFileSync(changelogPath, "utf-8");
  const results: BreakingChange[] = [];
  let currentSection: BreakingChange | null = null;
  let inBreaking = false;
  let inVersion = false;
  let versionMatch = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();

    // Detect version header: ## [X.Y.Z]
    const versionHeader = line.match(/^##\s+\[(\d+\.\d+\.\d+)\]/);
    if (versionHeader) {
      const ver = versionHeader[1];
      // Stop if we've passed the bound version
      if (versionGte(boundVersion, ver)) break;
      // Start tracking if within range
      if (versionGte(currentVersion, ver) && !versionGte(ver, boundVersion)) {
        inVersion = true;
        versionMatch = ver;
      } else {
        inVersion = false;
      }
      inBreaking = false;
      continue;
    }

    if (!inVersion) continue;

    // Detect "### Breaking Changes" section
    if (/^###\s+Breaking\s+Changes/i.test(line)) {
      inBreaking = true;
      currentSection = { version: versionMatch, summary: "", details: [] };
      results.push(currentSection);
      continue;
    }

    // Exit breaking section on next heading
    if (inBreaking && /^###\s+/.test(line) && !/^###\s+Breaking\s+Changes/i.test(line)) {
      inBreaking = false;
      continue;
    }
    // Also exit on next version
    if (inBreaking && /^##\s+\[/.test(line)) {
      inBreaking = false;
      continue;
    }

    if (inBreaking && currentSection && line.startsWith("- ")) {
      currentSection.details.push(line.slice(2).trim());
    }
  }

  return results.reverse(); // chronological order
}

/**
 * Map breaking change descriptions to known pi APIs and check Lumio usage.
 */
function crossReferenceBreakingChanges(
  breakingChanges: BreakingChange[],
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];

  // Known API patterns that may be affected by specific breaking changes
  const apiChecks: Array<{
    keywords: string[];
    api: string;
    severity: CompatibilityIssue["severity"];
  }> = [
    // pi-ai API migration (0.80.0)
    {
      keywords: ["pi-ai", "compat", "stream", "complete", "getModel", "getModels", "getProviders"],
      api: "@earendil-works/pi-ai direct imports",
      severity: "medium",
    },
    // tool_result event (0.24.0)
    {
      keywords: ["tool_result", "ToolResultEvent", "result: string", "content:"],
      api: "tool_result hook event",
      severity: "high",
    },
    // session_start vs session (0.23.0)
    {
      keywords: ["session_start", "session_switch", "unified session"],
      api: "session lifecycle events",
      severity: "high",
    },
    // Skills SKILL.md convention (0.20.0)
    {
      keywords: ["SKILL.md", "skills convention"],
      api: "skills loading format",
      severity: "low",
    },
    // Custom tools index.ts (0.24.0)
    {
      keywords: ["custom tools", "index.ts", "multi-file tools"],
      api: "custom tool loading",
      severity: "low",
    },
    // RPC protocol (0.16.0)
    {
      keywords: ["RPC", "rpc protocol", "RpcClient"],
      api: "RPC mode protocol",
      severity: "low",
    },
    // Theme color tokens (0.14.0)
    {
      keywords: ["thinkingXhigh", "bashMode", "theme color tokens"],
      api: "theme color tokens",
      severity: "low",
    },
  ];

  for (const change of breakingChanges) {
    const combined = change.details.join(" ").toLowerCase();

    for (const check of apiChecks) {
      if (check.keywords.some((kw) => combined.includes(kw.toLowerCase()))) {
        // Check if Lumio actually uses this API
        const files = new Set<string>();
        for (const kw of check.keywords.slice(0, 2)) {
          for (const f of findSourceFiles(REPO_ROOT, kw)) {
            files.add(f);
          }
        }

        const severity = files.size > 0 ? check.severity : "low";

        issues.push({
          severity,
          message: `pi ${change.version}: ${change.details[0] ?? change.summary}`,
          api: check.api,
          files: [...files].sort(),
        });
      }
    }
  }

  return issues;
}

// ── Upstream check ─────────────────────────────────────────────────

function checkUpstream(source: UpstreamSource): UpstreamUpdate | null {
  const repoUrl = `https://github.com/${source.repo}.git`;

  // Get latest commit on default branch
  const lsOutput = cmd(`git ls-remote --heads "${repoUrl}" 2>/dev/null`);
  if (!lsOutput) {
    console.warn(`  ⚠ Cannot reach ${source.repo}`);
    return null;
  }

  // Find main/master branch
  const refs = lsOutput.split("\n").map((line) => {
    const [sha, ref] = line.split(/\s+/);
    return { sha, ref };
  });

  const mainRef =
    refs.find((r) => r.ref === "refs/heads/main") ??
    refs.find((r) => r.ref === "refs/heads/master");

  if (!mainRef) return null;

  const newRef = mainRef.sha.slice(0, 8);

  if (source.lastCheckedRef === newRef) return null;

  // Get commit details
  let commitCount = 0;
  let subject = "";
  let newDate = "";

  if (source.lastCheckedRef) {
    // Count commits between last checked and current
    const logOutput = cmd(
      `git ls-remote "${repoUrl}" 2>/dev/null && ` +
      `gh api "repos/${source.repo}/compare/${source.lastCheckedRef}...${mainRef.sha.slice(0, 8)}" --jq ".total_commits, .commits[0].commit.message, .commits[0].commit.committer.date" 2>/dev/null`,
    );
    const lines = logOutput.split("\n").filter(Boolean);
    commitCount = parseInt(lines[0] ?? "0", 10) || 0;
    if (commitCount > 0) {
      subject = (lines[1] ?? "").split("\n")[0]?.trim() ?? "";
      newDate = lines[2] ?? "";
    }
  } else {
    // First check: just get the latest commit
    const lastCommit = cmd(
      `gh api "repos/${source.repo}/commits/${mainRef.sha.slice(0, 8)}" --jq ".commit.message, .commit.committer.date" 2>/dev/null`,
    );
    const lastLines = lastCommit.split("\n").filter(Boolean);
    commitCount = 1;
    subject = (lastLines[0] ?? "").split("\n")[0]?.trim() ?? "";
    newDate = lastLines[1] ?? "";
  }

  return {
    source,
    newRef,
    newDate,
    subject,
    commitCount,
  };
}

// ── Output ─────────────────────────────────────────────────────────

function printHeader(title: string): void {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}`);
}

function severityIcon(severity: CompatibilityIssue["severity"]): string {
  switch (severity) {
    case "high": return "🔴";
    case "medium": return "🟡";
    case "low": return "🟢";
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🔍 Lumio Compatibility & Upstream Check\n");

  // ── 1. Pi version compatibility ──────────────────────────────────
  printHeader("1. Pi Version Compatibility");

  const piVersionFile = readJson<PiVersionFile>(PI_VERSION_PATH);
  const boundVersion = piVersionFile.piVersion;
  const currentVersion = getCurrentPiVersion();

  console.log(`   Bound version:   ${boundVersion}`);
  console.log(`   Current version:  ${currentVersion}`);

  if (!versionGte(currentVersion, boundVersion)) {
    console.log(`\n   ✅ Pi is at or below the bound version. Nothing to check.`);
  } else if (currentVersion === boundVersion) {
    console.log(`\n   ✅ Pi matches bound version. No updates detected.`);
  } else {
    console.log(`\n   ⚡ Pi was updated (${boundVersion} → ${currentVersion}). Checking compatibility...`);

    const changelogPath = getChangelogPath();
    const breakingChanges = extractBreakingChanges(changelogPath, boundVersion, currentVersion);

    if (breakingChanges.length === 0) {
      console.log(`\n   ✅ No breaking changes found in the pi CHANGELOG since ${boundVersion}.`);
    } else {
      console.log(`\n   ⚠  ${breakingChanges.length} version(s) with breaking changes detected:`);
      for (const change of breakingChanges) {
        console.log(`\n   📦 pi ${change.version}:`);
        for (const detail of change.details.slice(0, 3)) {
          console.log(`      • ${detail}`);
        }
      }

      const issues = crossReferenceBreakingChanges(breakingChanges);
      if (issues.some((i) => i.severity !== "low")) {
        console.log(`\n   ⚠  Potential compatibility issues with Lumio:`);
        for (const issue of issues) {
          console.log(`\n   ${severityIcon(issue.severity)} [${issue.severity.toUpperCase()}] ${issue.message}`);
          console.log(`      API: ${issue.api}`);
          if (issue.files.length > 0) {
            const fileList = issue.files.slice(0, 5).join(", ");
            const more = issue.files.length > 5 ? ` (+${issue.files.length - 5} more)` : "";
            console.log(`      Files: ${fileList}${more}`);
          }
        }
      } else {
        console.log(`\n   ✅ No Lumio source files appear affected by these breaking changes.`);
      }
    }
  }

  // ── 2. Upstream monitoring ───────────────────────────────────────
  printHeader("2. Upstream Extension Monitoring");

  const upstreamsFile = readJson<UpstreamsFile>(UPSTREAMS_PATH);
  let anyUpdates = false;

  for (const source of upstreamsFile.sources) {
    console.log(`\n   📂 ${source.id}`);
    console.log(`      ${source.reason}`);

    const update = checkUpstream(source);

    if (!update) {
      if (source.lastCheckedRef) {
        console.log(`      ✅ No new commits (at ${source.lastCheckedRef})`);
      } else {
        console.log(`      ⚠  Could not reach upstream repository`);
      }
      continue;
    }

    anyUpdates = true;
    if (!source.lastCheckedRef) {
      console.log(`      🆕 First check. Latest: ${update.newRef} — "${update.subject}"`);
    } else {
      console.log(`      🔄 ${update.commitCount} new commit(s) since ${source.lastCheckedRef.slice(0,8)}`);
      console.log(`      Latest: ${update.newRef} (${update.newDate}) — "${update.subject}"`);
    }

    // Update the last checked ref
    source.lastCheckedRef = update.newRef;
  }

  if (!anyUpdates) {
    console.log(`\n   ✅ All upstreams are up to date.`);
  }

  // Save updated upstream refs
  writeJson(UPSTREAMS_PATH, upstreamsFile);

  // Update pi-version lastChecked
  piVersionFile.lastChecked = new Date().toISOString().split("T")[0];
  writeJson(PI_VERSION_PATH, piVersionFile);

  console.log(`\n${"─".repeat(60)}`);
  console.log("  Done. Upstream refs and check date saved.\n");
}

main().catch((err) => {
  console.error("Check failed:", err);
  process.exit(1);
});
