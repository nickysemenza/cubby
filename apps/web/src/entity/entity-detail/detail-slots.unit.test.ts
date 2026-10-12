import type { RunOut } from "@cubby/schemas/run";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { detailSlotsFor } from "./detail-slots";

// Non-purchase Runs once had no detail page. Their shared evidence must render
// without claiming purchase workflow slots. Live and stopped progress variants
// still split on whether an import Run is moving.
const IMPORT_SLOTS = [
  "import-controls",
  "import-stats",
  "import-agent-live",
  "import-purchases",
  "import-approvals",
  "import-findings",
  "import-targets",
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
          slot.applies?.(fromPartial<RunOut>({ purpose, status }) as never) !==
          false,
      )
      .map(([id]) => id);

  it.each<[RunOut["purpose"], string[]]>([
    [
      "ai_suggest",
      ["import-timeline", "import-debug-log", "ai-usage", "changes"],
    ],
    [
      "mail_search",
      ["import-timeline", "import-debug-log", "ai-usage", "changes"],
    ],
    [
      "background",
      ["import-timeline", "import-debug-log", "ai-usage", "changes"],
    ],
    [
      "suggestion_sweep",
      [
        "import-timeline",
        "import-debug-log",
        "suggestions",
        "ai-usage",
        "changes",
      ],
    ],
    [
      "photo_inventory",
      [
        "import-timeline",
        "import-debug-log",
        "photo-batch",
        "ai-usage",
        "changes",
      ],
    ],
  ])("a %s run renders %j", (purpose, expected) => {
    expect(applying(purpose, "completed")).toEqual([
      "live-progress",
      ...expected,
    ]);
  });

  it.each<[RunOut["purpose"]]>([
    ["mail_import"],
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
    const ids = applying("mail_import", "running");
    expect(ids).toContain("import-progress-live");
    expect(ids).not.toContain("import-progress-stopped");
  });
});
