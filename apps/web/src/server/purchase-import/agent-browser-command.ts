import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { BrowserBridgeOperation } from "@cubby/schemas/purchase-import";
import type { ResearchWorkObserveInput } from "@cubby/schemas/research-tools";

type ResearchBrowserScope = {
  allowedHosts: string[];
  runShortcode: string;
  workRef: string;
  recoveryURL?: string;
  screenshot?: Extract<BrowserBridgeOperation, { type: "read" }>["screenshot"];
};

/** Recovery recreates a missing owned window; only explicit navigation changes its page. */
export function resolveResearchBrowserOperation(
  action: ResearchWorkObserveInput["action"],
  scope: ResearchBrowserScope,
): BrowserBridgeOperation {
  const { allowedHosts } = scope;
  switch (action.kind) {
    case "navigate":
      return { type: "navigate", url: action.url, allowedHosts };
    case "read":
      return {
        type: "read",
        allowedHosts,
        screenshot: scope.screenshot ?? "preferred",
        recoveryURL: scope.recoveryURL,
        evidenceScope: {
          runId: parseShortcodeFor("run", scope.runShortcode),
          targetId: scope.workRef,
        },
      };
    case "scroll":
      return {
        type: "scroll",
        pageCount: action.direction === "up" ? -1 : 1,
        allowedHosts,
      };
    case "click":
      return {
        type: "click",
        observationId: action.observationId,
        ref: action.ref,
        allowedHosts,
      };
    case "type":
      return {
        type: "type",
        observationId: action.observationId,
        ref: action.ref,
        allowedHosts,
        text: action.text,
        submit: action.submit ?? false,
      };
    case "select":
      return {
        type: "select",
        observationId: action.observationId,
        ref: action.ref,
        optionRef: action.optionRef,
        allowedHosts,
      };
  }
}
