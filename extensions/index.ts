import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lumio", {
    description: "Show Lumio status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Lumio loaded.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("lumio", "loaded");
  });
}
