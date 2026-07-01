/**
 * Lumio maintenance check command.
 *
 * Registers /lumio-check that runs scripts/lumio-check.ts via pi.exec()
 * and streams the output back to the user.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CHECK_SCRIPT = resolve(import.meta.dirname, "../../scripts/lumio-check.ts");

export default function lumioCheckCommand(pi: ExtensionAPI) {
  pi.registerCommand("lumio-check", {
    description: "Run Lumio compatibility check and upstream monitoring",
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase();

      if (trimmed === "--help" || trimmed === "-h" || trimmed === "help") {
        showHelp(ctx);
        return;
      }

      if (!existsSync(CHECK_SCRIPT)) {
        ctx.ui.notify(
          `lumio-check script not found at ${CHECK_SCRIPT}. Make sure you are running from the Lumio repo.`,
          "error",
        );
        return;
      }

      ctx.ui.notify("Running Lumio compatibility check...", "info");

      const result = await pi.exec("npx", ["tsx", CHECK_SCRIPT], {
        cwd: resolve(import.meta.dirname, "../.."),
        timeout: 60_000,
      });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

      if (!output) {
        ctx.ui.notify("Check completed with no output.", "info");
        return;
      }

      if (ctx.hasUI) {
        // Show result in a scrollable overlay via editor
        await ctx.ui.editor(
          "Lumio Check Results — press Enter to dismiss",
          output,
        );
      } else {
        console.log(output);
      }
    },
  });
}

function showHelp(ctx: ExtensionCommandContext): void {
  const help = [
    "Usage: /lumio-check",
    "",
    "Runs two checks from scripts/lumio-check.ts:",
    "  1. Pi version compatibility — compares installed pi against the",
    "     version bound in pi-version.json, parses the pi CHANGELOG for",
    "     breaking changes, and cross-references Lumio source code.",
    "  2. Upstream monitoring — checks upstreams.json sources (e.g.",
    "     diegopetrucci/pi-extensions, mitsuhiko/agent-stuff) for new",
    "     commits since last check.",
    "",
    "Also available as: npm run check",
  ].join("\n");
  ctx.ui.notify(help, "info");
}
