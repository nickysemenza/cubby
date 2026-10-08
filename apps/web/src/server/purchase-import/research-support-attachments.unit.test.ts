import { runEntityId } from "@cubby/schemas/identifiers";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
// Retained original receipts must reach independent assessment as binary input;
// altered bytes or mismatched attachment metadata must fail before inference.
import { sha256Hex } from "@cubby/shared/sha256";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as featureRunner from "~/server/ai/run-feature";
import { Database } from "~/server/db";

import { assessResearchProposal } from "./research-support";

const db = new Database(() => {
  throw new Error("Source support transport tests do not query a database.");
});
const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");
const evidenceId = "00000000-0000-4000-8000-000000000002";
const attachmentRef = "00000000-0000-4000-8000-000000000003";
async function input() {
  const bytes = new TextEncoder().encode(
    "Synthetic original receipt: kettle XL copper variant.",
  );
  const checksum = await sha256Hex(bytes);
  const originalAttachment = {
    attachmentRef,
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    checksum,
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
  return {
    bytes,
    originalAttachment,
    assessment: {
      db,
      runId,
      context: {},
      observations: [
        {
          evidenceId,
          metadata: { attachmentRef, attachmentChecksum: checksum },
          content: JSON.stringify({ originalAttachment }),
        },
      ],
      proposal: researchWorkResolve.parse({
        workRef: "00000000-0000-4000-8000-000000000004",
        status: "verified" as const,
        identity: {
          evidenceIds: [evidenceId],
          reasoning: "The original receipt identifies the purchased variant.",
        },
        facts: [
          {
            evidenceId,
            fieldPath: "notes",
            value: "Kettle XL copper",
            support: {
              observation: "kettle XL copper variant",
              reasoning:
                "The retained original names this exact purchased variant.",
            },
          },
        ],
        detail: "Variant supported by original receipt.",
      }),
    },
  };
}
describe("independent original attachment assessment", () => {
  afterEach(() => vi.restoreAllMocks());
  it("supplies the original PDF bytes with their observation reference rather than an extracted summary", async () => {
    const f = await input();
    let sawOriginal = false;
    let text = "";
    vi.spyOn(featureRunner, "runStructuredFeature").mockImplementation(
      async (_feature, request) => {
        for (const message of request.messages) {
          if (!Array.isArray(message.content)) continue;
          for (const part of message.content) {
            if (part.type === "text") text += part.content;
            if (
              part.type === "document" &&
              part.source.type === "inline" &&
              part.source.value === f.originalAttachment.dataBase64
            )
              sawOriginal = true;
          }
        }
        return researchAssessment.parse({
          identityVerified: sawOriginal,
          acceptedFacts: sawOriginal ? [0] : [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [],
        });
      },
    );
    const accepted = await assessResearchProposal(f.assessment);
    expect.soft(sawOriginal).toBe(true);
    expect.soft(text).toContain(evidenceId);
    expect.soft(text).not.toContain(f.originalAttachment.dataBase64);
    expect.soft(accepted.acceptedFacts).toEqual([0]);
  });
  it.each(["bytes", "binding"] as const)(
    "rejects a changed attachment %s before semantic inference",
    async (changed) => {
      const f = await input();
      if (changed === "bytes")
        f.assessment.observations[0]!.content = JSON.stringify({
          originalAttachment: {
            ...f.originalAttachment,
            dataBase64: Buffer.from("different original").toString("base64"),
          },
        });
      else
        f.assessment.observations[0]!.metadata.attachmentChecksum = "f".repeat(
          64,
        );
      const runner = vi
        .spyOn(featureRunner, "runStructuredFeature")
        .mockResolvedValue(
          researchAssessment.parse({
            identityVerified: false,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            rejected: [],
          }),
        );
      await expect(assessResearchProposal(f.assessment)).rejects.toThrow(
        /attachment|checksum|original/,
      );
      expect(runner).not.toHaveBeenCalled();
    },
  );
});
