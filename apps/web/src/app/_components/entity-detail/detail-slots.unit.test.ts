import type { ImportRunOut } from "@cubby/schemas/import-run";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { detailSlotsFor } from "./detail-slots";

// A Run's page is the generic detail; its purpose decides which slots render.
// AI runs (no vendor, orders or transcript) once had no page at all, so the
// import workflow must never claim them — nor any run lose usage or changes.
describe("Run detail slots", () => {
  const slots = detailSlotsFor("importRun") ?? {};
  const applying = (purpose: ImportRunOut["purpose"]) =>
    Object.entries(slots)
      .filter(
        ([, slot]) =>
          // SAFETY: the erased map takes `never`; this is a Run record.
          slot.applies?.(fromPartial<ImportRunOut>({ purpose }) as never) !==
          false,
      )
      .map(([id]) => id);

  it.each<[ImportRunOut["purpose"], string[]]>([
    ["ai_suggest", ["ai-usage", "changes"]],
    ["ai_action", ["ai-usage", "changes"]],
    ["background", ["ai-usage", "changes"]],
    ["photo_inventory", ["photo-batch", "ai-usage", "changes"]],
    ["account_sync", ["import-workflow", "ai-usage", "changes"]],
    ["purchase_validation", ["import-workflow", "ai-usage", "changes"]],
    ["product_enrichment", ["import-workflow", "ai-usage", "changes"]],
    ["file_import", ["import-workflow", "ai-usage", "changes"]],
    ["legacy", ["import-workflow", "ai-usage", "changes"]],
  ])("a %s run renders %j", (purpose, expected) => {
    expect(applying(purpose)).toEqual(expected);
  });
});
