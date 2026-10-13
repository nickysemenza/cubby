import {
  type ReportBlock,
  entityReportOut,
} from "@cubby/schemas/entity-report";
import { imageIdentificationResult } from "@cubby/schemas/image-identification";
import { describe, expect, it } from "vitest";

import { imageIdentificationBlocks } from "./records";

const result = imageIdentificationResult.parse({
  subject: "single_object",
  category: "Synthetic tools",
  outcome: "suggestions",
  candidates: [
    { productId: "PRD-4K7M", name: "Synthetic wrench", probability: 0.82 },
  ],
  considered: 8,
  truncated: false,
});

const rowsOf = (blocks: ReportBlock[]) =>
  blocks.flatMap((block) => (block.kind === "records" ? block.rows : []));

describe("retained image identification report", () => {
  // Generic clients must not mistake a suggested Product for a confirmed attachment.
  it("links candidates as unconfirmed observations without offering mutations", () => {
    const blocks = imageIdentificationBlocks(result);
    expect(rowsOf(blocks)).toMatchObject([
      {
        entity: "product",
        id: "PRD-4K7M",
        title: "Synthetic wrench",
        statuses: [{ label: "Unconfirmed", tone: "warning" }],
        trailing: "82%",
      },
    ]);
    expect(
      rowsOf(blocks).every(
        (row) => !row.commands?.length && !row.actions?.length && !row.choice,
      ),
    ).toBe(true);
    expect(
      blocks.every(
        (block) =>
          block.kind !== "records" || (!block.actions?.length && !block.form),
      ),
    ).toBe(true);
    expect(entityReportOut.safeParse({ blocks }).success).toBe(true);
  });

  it("retains one identity represented by multiple related objects", () => {
    expect(
      rowsOf(
        imageIdentificationBlocks({
          ...result,
          subject: "multiple_objects",
          identityScope: "single_identity",
        }),
      ),
    ).toHaveLength(1);
  });

  it("does not expose candidates when the retained result abstains or is missing", () => {
    expect(imageIdentificationBlocks(null)).toEqual([]);
    const blocks = imageIdentificationBlocks({
      ...result,
      subject: "multiple_objects",
      outcome: "not_single_identity",
    });
    expect(rowsOf(blocks)).toEqual([]);
    expect(
      blocks.some(
        (block) =>
          block.kind === "note" && /one catalog identity/.test(block.text),
      ),
    ).toBe(true);
  });

  it("explains a bounded search even when all suggested Products were deleted", () => {
    const blocks = imageIdentificationBlocks({
      ...result,
      candidates: [],
      truncated: true,
    });
    expect(rowsOf(blocks)).toEqual([]);
    expect(
      blocks.some(
        (block) => block.kind === "note" && /live Product/.test(block.text),
      ),
    ).toBe(true);
    expect(
      blocks.some(
        (block) => block.kind === "note" && /limited/.test(block.text),
      ),
    ).toBe(true);
  });
});
