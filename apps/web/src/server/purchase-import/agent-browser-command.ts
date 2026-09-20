import type { BrowserBridgeOperation } from "@cubby/schemas/purchase-import";

export type PurchaseAgentCommand = {
  kind:
    | "navigate_orders"
    | "capture_order"
    | "capture_pdf"
    | "capture_screenshot";
  target?: string;
};

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
