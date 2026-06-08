import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PermissionGateLevel = "confirm" | "block";

export type PermissionGateRule = {
  name: string;
  level: PermissionGateLevel;
  pattern: RegExp;
  reason: string;
};

const DEFAULT_RULES: PermissionGateRule[] = [
  {
    name: "rm-root",
    level: "block",
    pattern: /\brm\b[\s\S]*(?:^|[\s;&|])(?:\/|\/\*|~|~\/|\$HOME|\$HOME\/)(?=$|[\s;&|])/i,
    reason: "Refuses to remove root or home directory targets.",
  },
  {
    name: "rm-recursive",
    level: "confirm",
    pattern: /\brm\b(?=[\s\S]*(?:^|\s)(?:-[^\s]*[rR][^\s]*|--recursive)\b)/i,
    reason: "Recursive removal can delete many files.",
  },
  {
    name: "sudo",
    level: "confirm",
    pattern: /\bsudo\b/i,
    reason: "Command requests elevated privileges.",
  },
  {
    name: "chmod-unsafe",
    level: "confirm",
    pattern: /\bchmod\b[\s\S]*(?:\b777\b|\ba\+w\b)/i,
    reason: "Command may make files world-writable.",
  },
  {
    name: "chown-recursive",
    level: "confirm",
    pattern: /\bchown\b(?=[\s\S]*(?:^|\s)-[^\s]*[rR][^\s]*\b)/i,
    reason: "Recursive ownership changes are hard to undo.",
  },
  {
    name: "remote-script-pipe",
    level: "confirm",
    pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i,
    reason: "Command pipes a remote script into a shell.",
  },
  {
    name: "git-destructive",
    level: "confirm",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*[fdx][^\s]*)\b/i,
    reason: "Command may discard uncommitted git changes.",
  },
];

export function findPermissionGateMatches(
  command: string,
  rules: readonly PermissionGateRule[] = DEFAULT_RULES,
): PermissionGateRule[] {
  return rules.filter((rule) => rule.pattern.test(command));
}

export function registerPermissionGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;

    const matches = findPermissionGateMatches(command);
    if (matches.length === 0) return undefined;

    const summary = matches.map((rule) => `${rule.name}: ${rule.reason}`).join("\n");
    const blockers = matches.filter((rule) => rule.level === "block");

    if (blockers.length > 0) {
      return {
        block: true,
        reason: `Blocked by Lumio permission gate:\n${summary}`,
      };
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Dangerous command blocked by Lumio permission gate because no UI is available:\n${summary}`,
      };
    }

    const preview = command.length > 1200 ? `${command.slice(0, 1200)}\n…` : command;
    const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${preview}\n\nAllow?`, ["Yes", "No"]);

    if (choice !== "Yes") {
      return {
        block: true,
        reason: `Blocked by user via Lumio permission gate:\n${summary}`,
      };
    }

    return undefined;
  });
}
