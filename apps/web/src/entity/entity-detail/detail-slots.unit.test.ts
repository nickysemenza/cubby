import type { RunOut } from "@cubby/schemas/run";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { detailSlotsFor } from "./detail-slots";

// A Run's page is the generic detail; its purpose and status decide which slots render. AI runs
// (no vendor, orders or transcript) once had no page at all, so the import slots must never
// claim them, nor any run lose progress, usage or changes. The live and stopped progress
// variants split on whether the run is still moving.
const IMPORT_SLOTS = [
  "import-controls",
  "import-stats",
  "import-agent-live",
  "import-purchases",
  "import-approvals",
  "import-findings",
  "import-targets",
  "import-evidence",
  "import-prepared-orders",
  "import-agent-stopped",
  "import-timeline",
  "import-debug-log",
];

describe("Run detail slots", () => {
  const slots = detailSlotsFor("run") ?? {};
  const applying = (purpose: RunOut["purpose"], status: RunOut["status"]) =>
    Object.entries(slots)
      .filter(
        ([, slot]) =>
          // SAFETY: the erased map takes `never`; this is a Run record.
          slot.applies?.(fromPartial<RunOut>({ purpose, status }) as never) !==
          false,
      )
      .map(([id]) => id);

  it.each<[RunOut["purpose"], string[]]>([
    ["ai_suggest", ["ai-usage", "changes"]],
    ["mail_search", ["ai-usage", "changes"]],
    ["background", ["ai-usage", "changes"]],
    ["photo_inventory", ["photo-batch", "ai-usage", "changes"]],
  ])("a %s run renders %j", (purpose, expected) => {
    expect(applying(purpose, "completed")).toEqual([
      "live-progress",
      ...expected,
    ]);
  });

  it.each<[RunOut["purpose"]]>([
    ["account_sync"],
    ["purchase_validation"],
    ["product_enrichment"],
    ["file_import"],
  ])(
    "a stopped %s run renders the import workflow with its history",
    (purpose) => {
      const ids = applying(purpose, "completed");
      expect(ids).toEqual(
        expect.arrayContaining([...IMPORT_SLOTS, "import-progress-stopped"]),
      );
      expect(ids).not.toContain("import-progress-live");
    },
  );

  it("a running import run shows live progress, not the stopped variant", () => {
    const ids = applying("account_sync", "running");
    expect(ids).toContain("import-progress-live");
    expect(ids).not.toContain("import-progress-stopped");
  });
});
