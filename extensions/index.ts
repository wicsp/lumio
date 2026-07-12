/**
 * Lumio extension index.
 *
 * Layers (register order matters for event hooks):
 *   1. Core    — mechanism guards, context, input, quiet-tools
 *   2. Model   — per-provider capabilities
 *   3. Tools   — agent-facing tools (gnosis, librarian, oracle, review, todo, etc.)
 *   4. UI      — footer, questionnaire, plan-mode, lumio-check
 *   5. Notify  — agent_end notifications (bark, desktop/terminal)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Core (mechanism layer) ──────────────────────────────────────────
// Guards run first to intercept destructive actions, dirty repos, dangerous commands.
import { registerDirtyRepoGuard } from "./guards/dirty-repo";
import { registerPermissionGate } from "./guards/permission-gate";
import confirmDestructiveExtension from "./guards/confirm-destructive";

// Context & input shaping
import contextCapExtension from "./context/cap";
import contextInspectorExtension from "./context/inspector";
import inlineBashExtension from "./input/inline-bash";

// TUI rendering
import registerQuietTools from "./ui/quiet-tools";

// ── Model capabilities ──────────────────────────────────────────────
import fastModeExtension from "./model/fast-mode";

// ── Agent-facing tools ──────────────────────────────────────────────
import gnosisExtension from "./knowledge/gnosis";
import librarianExtension from "./knowledge/librarian";
import oracleExtension from "./knowledge/oracle";
import reviewExtension from "./review/review";
import triageCommentsExtension from "./review/triage-comments";
import questionnaireExtension from "./ui/questionnaire";
import todoExtension from "./todo/todo";
import agentWorkflowAuditExtension from "./workflows/agent-workflow-audit";
import atlasExtension from "./atlas/index";

// ── UI / experience ─────────────────────────────────────────────────
import registerMinimalFooter from "./ui/minimal-footer";
import planModeExtension from "./workflows/plan-mode";
import lumioCheckCommand from "./maintenance/lumio-check";

// ── Notifications ───────────────────────────────────────────────────
import barkExtension from "./notifications/bark";
import notifyExtension from "./notifications/notify";

export default function (pi: ExtensionAPI) {
	// ── Core ──────────────────────────────────────────────────────────
	registerDirtyRepoGuard(pi);
	registerPermissionGate(pi);
	confirmDestructiveExtension(pi);
	contextCapExtension(pi);
	contextInspectorExtension(pi);
	inlineBashExtension(pi);
	registerQuietTools(pi);

	// ── Model ─────────────────────────────────────────────────────────
	fastModeExtension(pi);

	// ── Agent-facing tools ────────────────────────────────────────────
	gnosisExtension(pi);
	librarianExtension(pi);
	oracleExtension(pi);
	reviewExtension(pi);
	triageCommentsExtension(pi);
	questionnaireExtension(pi);
	todoExtension(pi);
	agentWorkflowAuditExtension(pi);
	atlasExtension(pi);

	// ── UI / experience ───────────────────────────────────────────────
	registerMinimalFooter(pi);
	planModeExtension(pi);
	lumioCheckCommand(pi);

	// ── Notifications ─────────────────────────────────────────────────
	barkExtension(pi);
	notifyExtension(pi);

	// ── Lumio meta ────────────────────────────────────────────────────
	pi.registerCommand("lumio", {
		description: "Show Lumio status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Lumio loaded: guards, quiet tools, fast mode, and minimal footer are active.", "info");
		},
	});

	pi.on("session_start", async (_event, _ctx) => {
		// Lumio loaded
	});
}
