/**
 * Failures: a vendor-scoped approval authorizes another Vendor, all-history
 * or another mailbox; a vendor request names no Vendor; an existing lane's
 * request gains a Vendor list and no longer matches its stored receipts.
 */
import {
  executionAuthorizationInput,
  type ExecutionAuthorizationInput,
} from "@cubby/schemas/execution-authorization";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import {
  approvalContainsScope,
  requestedScopeFor,
} from "./execution-authorization";

const vendorA = parseEntityId("vendor", "00000000-0000-4000-8000-00000000000a");
const vendorB = parseEntityId("vendor", "00000000-0000-4000-8000-00000000000b");
const vendorC = parseEntityId("vendor", "00000000-0000-4000-8000-00000000000c");

const approval = (scope: unknown): ExecutionAuthorizationInput =>
  executionAuthorizationInput.parse({
    kind: "execution_authorization",
    version: 1,
    owner: {
      userId: "synthetic-user",
      ledgerPartyId: "00000000-0000-4000-8000-000000000001",
    },
    scope,
    meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
    expiresAt: "2027-01-01T00:00:00.000Z",
  });

const vendorAQueries = {
  vendorId: vendorA,
};
const vendorScopeInput = {
  kind: "vendor_backfill",
  mailboxId: "synthetic-mailbox",
  discovery: "vendor_history",
  senderPolicy: "verified_at_first_start",
  vendors: [
    vendorAQueries,
    {
      vendorId: vendorB,
    },
  ],
  receivedAfter: "2024-01-01",
  receivedBefore: "2026-10-01",
  candidateLimit: 50,
  productLimit: 20,
};
const vendorScope = approval(vendorScopeInput).scope;

describe("vendor-scoped execution authorization", () => {
  it("derives a request naming every approved Vendor and contains it", () => {
    const requested = requestedScopeFor(vendorScope);
    expect(requested).toEqual({
      mailboxId: "synthetic-mailbox",
      discovery: "vendor_history",
      vendorIds: [vendorA, vendorB],
    });
    expect(approvalContainsScope(vendorScope, requested)).toBe(true);
    expect(
      approvalContainsScope(vendorScope, {
        ...requested,
        vendorIds: [vendorB],
      }),
    ).toBe(true);
  });

  it.each([
    ["another Vendor", { vendorIds: [vendorA, vendorC] }],
    ["no Vendor", { vendorIds: [] }],
    ["an omitted Vendor list", { vendorIds: undefined }],
    [
      "all history",
      { discovery: "all_history" as const, vendorIds: undefined },
    ],
    ["another mailbox", { mailboxId: "synthetic-other" }],
  ])("refuses %s", (_, change) => {
    expect(
      approvalContainsScope(vendorScope, {
        ...requestedScopeFor(vendorScope),
        ...change,
      }),
    ).toBe(false);
  });

  it("keeps existing lanes' requests without a Vendor list", () => {
    const backfill = approval({
      kind: "backfill",
      mailboxId: "synthetic-mailbox",
      discovery: "all_history",
    }).scope;
    expect(requestedScopeFor(backfill)).toEqual({
      mailboxId: "synthetic-mailbox",
      discovery: "all_history",
    });
    expect(
      approvalContainsScope(backfill, {
        ...requestedScopeFor(backfill),
        vendorIds: [vendorA],
      }),
    ).toBe(false);
  });

  it("refuses a vendor approval without a bounded, distinct Vendor set", () => {
    expect(() =>
      approval({
        ...vendorScopeInput,
        vendors: [vendorAQueries, vendorAQueries],
      }),
    ).toThrow(/distinct/);
  });
});
