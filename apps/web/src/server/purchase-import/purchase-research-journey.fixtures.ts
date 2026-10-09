import { taxonomyShortcode } from "tooling/product-category-fixtures";
import {
  from,
  type ScriptStep,
  type ScriptValue,
} from "tooling/purchase-agent-script";

// Shared synthetic originals and external decisions for Worker and visible UI
// acceptance. Neither peer bypasses the retained observation/domain write path.
export const pageURL = "https://maker.example.test/fan?size=small&color=blue";
export const assetKey = "e2e/research/fan-small-blue.png";
export const assetURL = `https://assets.example.test/${assetKey}`;
export const orderedTitle = "Example Works portable fan — small, blue";
export const sourceText =
  "Order SYNTHETIC-410. Ordered 2026-09-14. Example Works portable fan — small, blue. Quantity 1. USD 24.00. Total USD 24.00.";
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const page = {
  title: orderedTitle,
  text: "Manufacturer: Example Works\nModel: F17SB\nCategory: Electronics\nSelected variant: small, blue\nManufacturer part: FAN-SM-BL\nOther variant: large, red, model F18LR, part FAN-LG-RD",
  images: [
    {
      url: assetURL,
      alt: "Selected small blue Example Works F17SB portable fan",
      width: 1,
      height: 1,
    },
  ],
};
export const support = {
  observation:
    "Example Works F17SB. Selected variant: small, blue. Manufacturer part: FAN-SM-BL.",
  reasoning:
    "The original ordered item is small and blue. The selected small blue variant is F17SB; the separately listed large red F18LR is a different item.",
  selectedVariant: {
    identity: "F17SB small blue",
    attributes: { size: "small", color: "blue" },
    reasoning: "The source explicitly distinguishes small blue from large red.",
  },
};
export const step = (
  id: string,
  tool: string,
  args: Record<string, ScriptValue> = {},
): ScriptStep => ({ call: id, tool, args });
// This reads the host's model-visible retained observation, never broker state.
const observed = (field: string): ScriptValue => ({
  $signal: "research_observation",
  path: field,
});
export const mailSteps: ScriptStep[] = [
  step("mail-next", "work_next"),
  step("mail-read", "mail_read", {
    workRef: from("mail-next", "work.workRef"),
    messageRef: from("mail-next", "work.sources.0.messageRef"),
  }),
  step("mail-resolve", "work_resolve", {
    workRef: from("mail-next", "work.workRef"),
    status: "verified",
    identity: {
      evidenceIds: [from("mail-read", "evidenceId")],
      reasoning:
        "The retained original names one exact ordered small blue fan and an itemized total.",
    },
    orders: [
      {
        vendor: {
          name: "Example Works",
          website: "https://maker.example.test",
        },
        evidenceIds: [from("mail-read", "evidenceId")],
        reasoning:
          "SYNTHETIC-410 has one item, known date, quantity and total in this original.",
        candidate: {
          orderId: "SYNTHETIC-410",
          orderedAt: "2026-09-14T12:00:00Z",
          merchant: "Example Works",
          currency: "USD",
          printedGrandTotal: 24,
          lines: [
            {
              title: orderedTitle,
              amount: 24,
              lineKind: "principal",
              quantity: 1,
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
        productResolutions: [{ kind: "new", lineIndex: 0 }],
        defaultTrade: "other",
      },
    ],
    detail:
      "Imported the retained itemized original without inventing a payment or receipt.",
  }),
];
export const productSteps: ScriptStep[] = [
  step("product-next", "work_next"),
  step("product-observe", "work_observe", {
    workRef: from("product-next", "work.workRef"),
    action: { kind: "navigate", url: pageURL },
  }),
  { await: ["research_observation"] },
  step("product-resolve", "work_resolve", {
    workRef: from("product-next", "work.workRef"),
    status: "verified",
    identity: {
      evidenceIds: [observed("evidenceId")],
      reasoning: support.reasoning,
    },
    facts: [
      {
        evidenceId: observed("evidenceId"),
        fieldPath: "manufacturer",
        value: "Example Works",
        support,
      },
      {
        evidenceId: observed("evidenceId"),
        fieldPath: "model",
        value: "F17SB",
        support,
      },
      {
        evidenceId: observed("evidenceId"),
        fieldPath: "categoryId",
        value: taxonomyShortcode("electronics"),
        support: {
          ...support,
          observation:
            "Category: Electronics. Example Works F17SB, selected small blue.",
        },
      },
    ],
    identifierClaims: [
      {
        evidenceId: observed("evidenceId"),
        kind: "manufacturer_part",
        externalId: "FAN-SM-BL",
        support,
      },
    ],
    imageCandidates: [
      {
        candidateRef: observed("imageCandidates.0.candidateRef"),
        evidenceIds: [observed("evidenceId")],
        support,
      },
    ],
    detail:
      "Verified manufacturer, model, category, visible part and the selected variant's representative image.",
  }),
];
