import { runEntityId } from "@cubby/schemas/identifiers";
/** Failures: filename overrides a model decision, uncertainty/low confidence promotes a file,
 * oversized evidence reaches the model, or model failure falls back to a heuristic. */
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";

import { shouldPromoteMailAttachment } from "./mail-attachment-purpose";

const mail = {
  sender: "orders@shop.example",
  subject: "Shipping paperwork",
  rawChecksum: "a".repeat(64),
  content: {
    bodyText: "The attached document confirms a shipping charge of $8.50.",
    bodyHtml: null,
    snippet: null,
  },
};
const attachment = {
  filename: "shipping-label.pdf",
  mimeType: "application/octet-stream",
  checksum: "b".repeat(64),
};
const usage = {
  runId: runEntityId.parse("00000000-0000-4000-8000-000000000001"),
  operation: "mail-attachment-purpose",
};

describe("mail attachment purpose", () => {
  it.each([
    { choice: "c0", probability: 0.98, promote: true },
    { choice: "c0", probability: 0.6, promote: false },
    { choice: "c1", probability: 0.98, promote: false },
    { choice: "c2", probability: 0.98, promote: false },
  ])(
    "promotes only a high-confidence document ($choice, $probability)",
    async ({ choice, probability, promote }) => {
      const port: DecisionPort = vi.fn<DecisionPort>(async () => ({
        answers: {
          selection: {
            type: "choice",
            choice,
            confidence: probability,
            probabilities: {
              c0: choice === "c0" ? probability : (1 - probability) / 2,
              c1: choice === "c1" ? probability : (1 - probability) / 2,
              c2: choice === "c2" ? probability : (1 - probability) / 2,
            },
          },
        },
      }));
      expect(
        await shouldPromoteMailAttachment(mail, attachment, usage, port),
      ).toBe(promote);
      expect(port).toHaveBeenCalledOnce();
    },
  );

  it("retains oversized evidence without invoking a model", async () => {
    const port: DecisionPort = vi.fn();
    expect(
      await shouldPromoteMailAttachment(
        { ...mail, content: { ...mail.content, bodyText: "x".repeat(40_000) } },
        attachment,
        usage,
        port,
      ),
    ).toBe(false);
    expect(port).not.toHaveBeenCalled();
  });

  it("propagates model failure without a filename fallback", async () => {
    const port: DecisionPort = vi.fn(async () => {
      throw new Error("Synthetic Decision outage");
    });
    await expect(
      shouldPromoteMailAttachment(mail, attachment, usage, port),
    ).rejects.toThrow("Synthetic Decision outage");
  });
});
