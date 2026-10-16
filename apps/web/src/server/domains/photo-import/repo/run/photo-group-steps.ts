import type { DecisionStep } from "@cubby/schemas/decision-step";

/** The retired UI default was never an agent-raised concern. */
export function effectivePhotoGroupConcern(
  reason: string | null | undefined,
): string | null {
  return reason === "Confirm the observed identity before applying this group"
    ? null
    : (reason ?? null);
}

/** Server policy: model inference never gates apply; retained image processing does. */
export function photoGroupSteps(input: {
  state: "proposed" | "committed" | "discarded";
  runStatus: string;
  kind: "create" | "existing";
  productName: string | null;
  productMissing: boolean;
  imageCount: number;
  skipCount: number;
  concern: string | null;
  stockIntent: string;
  inventoryMissing: boolean;
  descriptionBlocked: boolean;
}) {
  const settled = input.state !== "proposed";
  const skipOnly = input.imageCount === 0 && input.skipCount > 0;
  const productBlock = input.productMissing ? "Choose a live Product" : null;
  const identityBlock = input.descriptionBlocked
    ? "AI description is still processing or needs retry"
    : input.concern;
  const inventoryBlock =
    input.stockIntent === "receive" && input.inventoryMissing
      ? "A receive decision requires Inventory and a live Location"
      : null;
  const blockedReason = settled
    ? null
    : !["running", "needs_review"].includes(input.runStatus)
      ? `Run is ${input.runStatus}`
      : !input.imageCount && !input.skipCount
        ? "Every photo was deleted; remove this group"
        : skipOnly
          ? null
          : (productBlock ?? identityBlock ?? inventoryBlock);
  const action = input.kind === "create" ? "create" : "link";
  const steps: DecisionStep[] = [
    {
      key: "product",
      label: "Product",
      status: productBlock ? "needs_input" : "done",
      summary: input.productName,
      action,
      blockedReason: null,
    },
    {
      key: "identity",
      label: input.kind === "existing" ? "Right one?" : "Details",
      status: productBlock ? "blocked" : "needs_input",
      summary: identityBlock,
      action: input.kind === "create" ? "create" : "change",
      blockedReason: productBlock,
    },
    {
      key: "ownership",
      label: "Own it now?",
      status:
        productBlock || identityBlock
          ? "blocked"
          : inventoryBlock
            ? "needs_input"
            : "done",
      summary:
        input.stockIntent === "receive"
          ? "Receive into inventory"
          : "Reference only",
      action: input.stockIntent === "receive" ? "create" : null,
      blockedReason: productBlock ?? identityBlock,
    },
  ];
  if (settled)
    for (const step of steps) {
      step.status = "done";
      step.blockedReason = null;
    }
  else if (skipOnly)
    for (const step of steps.slice(0, 3)) {
      step.status = "not_needed";
      step.blockedReason = null;
    }
  return { steps, blockedReason };
}
