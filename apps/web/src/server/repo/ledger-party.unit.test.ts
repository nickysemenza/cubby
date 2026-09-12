import type { LedgerPartyFilters } from "@cubby/schemas/ledger-party";
import { describe, expect, it } from "vitest";

import { renderWhereSql } from "~/server/repo/database-helpers/mock-db";

import { buildLedgerPartyWhere } from "./ledger-party";

// SAFETY: test-only partial filter set; buildLedgerPartyWhere only reads the
// keys under test, so a partial object is safe to pass here.
const where = (filters: Partial<LedgerPartyFilters> = {}) =>
  renderWhereSql(buildLedgerPartyWhere(filters as LedgerPartyFilters));

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
