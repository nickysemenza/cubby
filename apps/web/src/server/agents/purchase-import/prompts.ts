import type { BrowserCapture } from "@cubby/schemas/purchase-import";
import type { ModelMessage } from "@tanstack/ai";

import { purchaseImportPromptText } from "./prompt-text.gen";

export const purchaseExtractionPrompt = (capture: BrowserCapture) => ({
  systemPrompts: [
    purchaseImportPromptText.extraction,
    purchaseImportPromptText.extractionOutput,
  ],
  messages: [
    {
      role: "user",
      content: JSON.stringify(capture),
    } satisfies ModelMessage,
  ],
});

export type PurchaseAuditRenderedBatch = readonly {
  id: string;
  orderId: string | null;
  statedTotal: number | null;
  displayLabel: string | null;
  expenses: readonly {
    id: string;
    name: string;
    amount: number | null;
    lineKind: string;
    quantity: number | null;
    product: {
      id: string;
      name: string | null;
      manufacturer: string | null;
      model: string | null;
    } | null;
  }[];
  paymentEvidence: readonly {
    amount: number;
    chargedAt: Date | null;
    cardLastFour: string | null;
    description: string | null;
  }[];
}[];

export const purchaseAuditPrompt = (
  renderedBatch: PurchaseAuditRenderedBatch,
) => ({
  systemPrompts: [purchaseImportPromptText.audit],
  messages: [
    {
      role: "user",
      content: JSON.stringify(renderedBatch),
    } satisfies ModelMessage,
  ],
});
