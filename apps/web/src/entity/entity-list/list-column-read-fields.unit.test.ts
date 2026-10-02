import { describe, expect, it } from "vitest";

import { ProgressiveListSession } from "../../ui/hooks/progressive-list";
import { listColumnReadFields } from "./list-column-read-fields";

// A synthetic display column can read a nested object absent from the core row.
// Resolving its declared projection must request and guard that object's group.
describe("list column deferred reads", () => {
  it("loads the ledger behind In service before exposing its nested count", async () => {
    const rows = [{ id: "synthetic-product", name: "Synthetic product" }];
    const groups = [{ id: "derived" as const, fields: ["quantityLedger"] }];
    const fields = listColumnReadFields("product", "servingAsLocations");
    const requested = groups
      .filter((group) => group.fields.some((field) => fields.includes(field)))
      .map((group) => group.id);
    const session = new ProgressiveListSession(() => {});
    session.reset("initial");
    session.setPages([rows]);
    await session.load(rows, requested, async (_ids, requestedGroups) => ({
      groups: requestedGroups.map((id) => ({
        id,
        state: "ready",
        data: [{ id: rows[0]!.id, quantityLedger: { locationCount: 2 } }],
      })),
      missingIds: [],
    }));
    expect(session.state(rows[0]!.id, "derived").state).toBe("ready");
    expect(session.rows()[0]).toMatchObject({
      quantityLedger: { locationCount: 2 },
    });
  });
});
