import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import contextCapExtension from "./context/cap";
import contextInspectorExtension from "./context/inspector";
import confirmDestructiveExtension from "./guards/confirm-destructive";
import { registerDirtyRepoGuard } from "./guards/dirty-repo";
import { registerPermissionGate } from "./guards/permission-gate";
import inlineBashExtension from "./input/inline-bash";
import gnosisExtension from "./knowledge/gnosis";
import librarianExtension from "./knowledge/librarian";
import oracleExtension from "./knowledge/oracle";
import claudeFastExtension from "./model/claude-fast";
import openAIFastExtension from "./model/openai-fast";
import barkExtension from "./notifications/bark";
import notifyExtension from "./notifications/notify";
import reviewExtension from "./review/review";
import triageCommentsExtension from "./review/triage-comments";
import todoExtension from "./todo/todo";
import registerMinimalFooter from "./ui/minimal-footer";
import questionnaireExtension from "./ui/questionnaire";
import registerQuietTools from "./ui/quiet-tools";
import agentWorkflowAuditExtension from "./workflows/agent-workflow-audit";
import planModeExtension from "./workflows/plan-mode";

export default function (pi: ExtensionAPI) {
  registerDirtyRepoGuard(pi);
  registerPermissionGate(pi);
  registerMinimalFooter(pi);
  registerQuietTools(pi);
  planModeExtension(pi);
  questionnaireExtension(pi);

  // Localized Lumio modules, initially imported from @diegopetrucci/pi-extensions and organized by purpose.
  agentWorkflowAuditExtension(pi);
  barkExtension(pi);
  confirmDestructiveExtension(pi);
  contextCapExtension(pi);
  contextInspectorExtension(pi);
  gnosisExtension(pi);
  inlineBashExtension(pi);
  librarianExtension(pi);
  notifyExtension(pi);
  claudeFastExtension(pi);
  openAIFastExtension(pi);
  oracleExtension(pi);
  reviewExtension(pi);
  todoExtension(pi);
  triageCommentsExtension(pi);
  pi.registerCommand("lumio", {
    description: "Show Lumio status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Lumio loaded: guards, minimal footer, and quiet tool previews are active.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Lumio loaded
  });
}
