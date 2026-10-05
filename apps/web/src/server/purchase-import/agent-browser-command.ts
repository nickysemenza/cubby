import type { PurchaseAgentCommand } from "@cubby/schemas/purchase-agent-services";
import type { BrowserBridgeOperation } from "@cubby/schemas/purchase-import";

/**
 * Resolve the model's semantic request into a self-contained broker command. A capture carries
 * the server-selected work URL so a Mac that restarted after `navigate` can recreate only the
 * dedicated, allowlisted window instead of adopting a person's existing browser window.
 */
export function resolvePurchaseAgentBrowserOperation(
  command: PurchaseAgentCommand,
  claimedTarget: string | null | undefined,
  allowedHosts: string[],
): BrowserBridgeOperation {
  const target = command.target ?? claimedTarget;
  return command.kind === "navigate_orders"
    ? {
        type: "navigate",
        url: target ?? "",
        allowedHosts,
      }
    : {
        type: "capture",
        allowedHosts,
        enhancedEvidence:
          command.kind === "capture_pdf" ||
          command.kind === "capture_screenshot",
        recoveryURL: target ?? undefined,
      };
}
