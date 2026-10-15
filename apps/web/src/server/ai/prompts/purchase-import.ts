import type {
  BrowserCapture,
  ImportExtractionOutcome,
} from "@cubby/schemas/purchase-import";

import type { AiMessage, AiChatRequest } from "~/server/ai/run-feature";
import { purchaseImportPromptText } from "~/server/domains/purchase-import/agents/prompt-text.gen";

export const purchaseExtractionPrompt = (capture: BrowserCapture) => ({
  systemPrompts: [
    purchaseImportPromptText.extraction,
    purchaseImportPromptText.extractionOutput,
  ],
  messages: [
    {
      role: "user",
      content: JSON.stringify(capture),
    } satisfies AiMessage,
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
    } satisfies AiMessage,
  ],
});

export const SUM_MISMATCH_ISSUE =
  "Lines do not equal the printed grand total; retain the candidate and return needs_review with sum_mismatch.";

function purchaseRepairMessages(
  originalMessages: readonly AiMessage[],
  issues: readonly string[],
  previous: ImportExtractionOutcome,
  screenshotUrl: string | null,
): AiMessage[] {
  return [
    ...originalMessages,
    {
      role: "user",
      content: [
        ...(screenshotUrl
          ? [
              {
                type: "image" as const,
                source: { type: "url" as const, value: screenshotUrl },
              },
            ]
          : []),
        {
          type: "text",
          content: `The prior extraction failed validation:\n${issues.map((issue) => `- ${issue}`).join("\n")}\nRepair it once using the screenshot when present. If the visible lines still cannot equal the printed grand total, retain the candidate and return needs_review with reason sum_mismatch.\n\nPrior extraction:\n${JSON.stringify(previous)}`,
        },
      ],
    },
  ];
}

const exampleInvalidExtraction: ImportExtractionOutcome = {
  status: "ready",
  candidate: {
    orderId: "example-1",
    orderedAt: null,
    merchant: "Example Tools",
    currency: "USD",
    printedGrandTotal: 80,
    lines: [
      { title: "Cordless drill kit", amount: 79.95, lineKind: "principal" },
    ],
    payments: [],
    allShipmentsDelivered: null,
  },
};

/**
 * An AI-only probe for the repair prompt, without an extraction write: the
 * smoke run and the routing eval send the exact repair turn production sends
 * after `previous` fails validation.
 */
export function purchaseRepairRequest(
  capture: BrowserCapture,
  previous: ImportExtractionOutcome = exampleInvalidExtraction,
) {
  const request = purchaseExtractionPrompt(capture);
  return purchaseRepairPrompt(request, [SUM_MISMATCH_ISSUE], previous, null);
}

export const orderMailRequest = (args: {
  sender: string;
  subject: string;
  receivedAt: string;
  content: unknown;
}) => ({
  systemPrompts: [purchaseImportPromptText.orderMail],
  messages: [{ role: "user" as const, content: JSON.stringify(args) }],
});

export const purchaseReceiptRequest = (args: {
  evidenceUrl: string;
  mediaType: string;
}): AiChatRequest => ({
  systemPrompts: [purchaseImportPromptText.receiptExtraction],
  messages: [
    {
      role: "user",
      content: [
        args.mediaType === "application/pdf"
          ? {
              type: "document",
              source: {
                type: "url",
                value: args.evidenceUrl,
                mimeType: args.mediaType,
              },
            }
          : {
              type: "image",
              source: {
                type: "url",
                value: args.evidenceUrl,
                mimeType: args.mediaType,
              },
            },
        { type: "text", content: "Extract this confirmed receipt." },
      ],
    } satisfies AiMessage,
  ],
});

export function purchaseRepairPrompt(
  request: AiChatRequest,
  issues: readonly string[],
  previous: ImportExtractionOutcome,
  screenshotUrl: string | null,
): AiChatRequest {
  return {
    systemPrompts: request.systemPrompts,
    messages: purchaseRepairMessages(
      request.messages,
      issues,
      previous,
      screenshotUrl,
    ),
  };
}
