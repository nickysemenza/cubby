import { enrichmentProposalPrecomputeInput } from "@cubby/schemas/ai";
import { enrichmentRowOut } from "@cubby/schemas/ingredient";
import { describe, expect, it } from "vitest";

/**
 * The review queue's AI lookahead feeds `enrichmentRowOut` rows straight into
 * `precomputeEnrichmentProposals`. That input declared `ingredientId` (a uuid
 * brand) while the rows carry shortcodes, so **every** precompute request failed
 * validation with "Invalid UUID" — the workbench's "precomputed 0/0" counter was
 * that bug, not an idle queue.
 *
 * These pin the two halves of the contract that has to line up: what the row
 * supplies, and what the input accepts.
 */
describe("enrichmentProposalPrecomputeInput", () => {
  const item = {
    id: "ING-4K7M",
    name: "bay leaves",
    wantUsda: true,
    wantMerge: false,
  };

  it("accepts the shortcode the review queue actually sends", () => {
    const parsed = enrichmentProposalPrecomputeInput.parse({ items: [item] });
    expect(parsed.items[0]?.id).toBe("ING-4K7M");
  });

  it("rejects a uuid, which is never what the client holds", () => {
    const result = enrichmentProposalPrecomputeInput.safeParse({
      items: [{ ...item, id: "3f1b7c4e-0000-4000-8000-000000000000" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a shortcode for a different entity", () => {
    const result = enrichmentProposalPrecomputeInput.safeParse({
      items: [{ ...item, id: "PRD-4K7M" }],
    });
    expect(result.success).toBe(false);
  });

  // The row's id is the cache key on the client, so the two must be the same
  // kind of id or every proposal lands under a key nothing reads back.
  it("accepts the id shape enrichmentRowOut declares", () => {
    const rowIdSchema = enrichmentRowOut.shape.id;
    expect(rowIdSchema.safeParse("ING-4K7M").success).toBe(true);
    expect(
      rowIdSchema.safeParse("3f1b7c4e-0000-4000-8000-000000000000").success,
    ).toBe(false);
  });
});
