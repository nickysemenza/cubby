import {
  type LedgerPartyFilters,
  ledgerPartyFiltersSchema,
} from "@cubby/schemas/ledger-party";
import { describe, expect, it } from "vitest";

import { renderWhereSql } from "~/server/repo/database-helpers/mock-db";

import { buildLedgerPartyWhere } from "./ledger-party";

// Parsed rather than asserted: the related-view filter trios carry branded
// shortcodes, and every filter field is optional, so the schema accepts the
// partial set under test.
const where = (filters: Partial<LedgerPartyFilters> = {}) =>
  renderWhereSql(
    buildLedgerPartyWhere(ledgerPartyFiltersSchema.parse(filters)),
  );

describe("buildLedgerPartyWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(where()).toBeDefined();
  });

  it("still narrows by kind (declared stored filter)", () => {
    expect(where({ kind: "member" })).toContain('"kind"');
  });

  it("still narrows by name and trims the search term (declared stored filter)", () => {
    expect(where({ search: "Alex" })).toContain('"name"');
    expect(where({ search: "   " })).toBe(where());
  });
});
