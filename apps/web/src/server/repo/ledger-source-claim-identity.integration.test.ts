import {
  ledgerSourceClaimInput,
  type LedgerSourceClaimInput,
} from "@cubby/schemas/ledger-transfer";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { ledgerSourceClaim } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import { createExpense, updateExpense } from "~/server/repo/expense/crud";
import { createLedgerParty } from "~/server/repo/ledger-party";
import {
  createLedgerTransfer,
  updateLedgerTransfer,
} from "~/server/repo/ledger-transfer";
import { makeExpenseInput } from "~/server/repo/repo.fixtures";

const evidence = {
  amount: 10,
  occurredOn: "2026-08-20",
  description: "Synthetic claim evidence",
  context: null,
  disambiguator: null,
};

/**
 * A client edits a claim by sending back what it read. The read carries `sourceKey` (the hash of
 * the claim's identity) and never the `providerId` it was made from, so the input must accept
 * the key and the server must keep that identity, or reject the edit loudly. Regression: a
 * re-sent claim was rehashed from its evidence, silently minting a second identity.
 */
describe("source claim identity round trip", () => {
  const ctx = withTestDb("mcp");

  const claimOf = (overrides: Partial<LedgerSourceClaimInput> = {}) =>
    ledgerSourceClaimInput.parse({
      source: "synthetic-provider",
      providerId: "synthetic-row-1",
      normalizedEvidence: evidence,
      reconciliation: { decision: "amounts_match" },
      ...overrides,
    });

  const expenseWithProviderClaim = async () => {
    const created = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Identity placeholder",
        cost: 10,
        sourceClaims: [claimOf()],
      }),
      ctx.actor,
    );
    const [read] = created.output.sourceClaims;
    if (!read) throw new Error("expected a claim");
    return { id: created.output.id, read };
  };

  /** What a client sends back: the read claim, clipped to the input's keys. */
  const resend = (
    read: { source: string; sourceKey: string },
    overrides: Partial<LedgerSourceClaimInput> = {},
  ) => ({
    source: read.source,
    sourceKey: read.sourceKey,
    normalizedEvidence: evidence,
    reconciliation: { decision: "amounts_match" as const },
    ...overrides,
  });

  it("keeps the identity of a provider-keyed claim re-sent by its key", async () => {
    const { id, read } = await expenseWithProviderClaim();
    const rows = () =>
      unwrapDb(ctx.db)
        .select({ id: ledgerSourceClaim.id, key: ledgerSourceClaim.sourceKey })
        .from(ledgerSourceClaim)
        .where(eq(ledgerSourceClaim.source, "synthetic-provider"));
    const before = await rows();

    const updated = await updateExpense(
      ctx.db,
      id,
      { sourceClaims: [ledgerSourceClaimInput.parse(resend(read))] },
      ctx.actor,
    );

    expect(updated.output.sourceClaims.map((claim) => claim.sourceKey)).toEqual(
      [read.sourceKey],
    );
    expect(await rows()).toEqual(before);
  });

  it("lets a keyed claim change its reconciliation but not its evidence", async () => {
    const { id, read } = await expenseWithProviderClaim();

    const reviewed = await updateExpense(
      ctx.db,
      id,
      {
        cost: 12,
        sourceClaims: [
          ledgerSourceClaimInput.parse(
            resend(read, {
              reconciliation: {
                decision: "accept_target_amount",
                note: "Reviewed against the synthetic receipt",
              },
            }),
          ),
        ],
      },
      ctx.actor,
    );
    expect(reviewed.output.sourceClaims).toMatchObject([
      {
        sourceKey: read.sourceKey,
        reconciliation: { decision: "accept_target_amount" },
      },
    ]);

    await expect(
      updateExpense(
        ctx.db,
        id,
        {
          sourceClaims: [
            ledgerSourceClaimInput.parse(
              resend(read, {
                normalizedEvidence: { ...evidence, description: "Edited" },
                reconciliation: {
                  decision: "accept_target_amount",
                  note: "Reviewed against the synthetic receipt",
                },
              }),
            ),
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/identity/u);
  });

  it("rejects a key that no claim on this record holds", async () => {
    const { id, read } = await expenseWithProviderClaim();
    const other = await createExpense(
      ctx.db,
      makeExpenseInput({ name: "Other placeholder", cost: 10 }),
      ctx.actor,
    );

    await expect(
      updateExpense(
        ctx.db,
        other.output.id,
        {
          sourceClaims: [ledgerSourceClaimInput.parse(resend(read))],
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/identity/u);
    await expect(
      updateExpense(
        ctx.db,
        id,
        {
          sourceClaims: [
            ledgerSourceClaimInput.parse(
              resend({ source: read.source, sourceKey: "v1:unknown" }),
            ),
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/identity/u);
  });

  it("refuses a claim that names both a provider id and a key", () => {
    expect(
      ledgerSourceClaimInput.safeParse(
        resend(
          { source: "synthetic-provider", sourceKey: "v1:abc" },
          {
            providerId: "synthetic-row-1",
          },
        ),
      ).success,
    ).toBe(false);
  });

  it("round-trips a ledger transfer's claim the same way", async () => {
    const from = await createLedgerParty(
      ctx.db,
      { name: "Synthetic sender", kind: "member", notes: null },
      ctx.actor,
    );
    const to = await createLedgerParty(
      ctx.db,
      { name: "Synthetic receiver", kind: "guest", notes: null },
      ctx.actor,
    );
    const created = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: from.output.id,
        toPartyId: to.output.id,
        amount: 10,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [claimOf()],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );
    const [read] = created.output?.sourceClaims ?? [];
    if (!created.output || !read) throw new Error("expected a claim");

    const updated = await updateLedgerTransfer(
      ctx.db,
      created.output.id,
      { sourceClaims: [ledgerSourceClaimInput.parse(resend(read))] },
      ctx.actor,
    );
    expect(
      updated.output?.sourceClaims.map((claim) => claim.sourceKey),
    ).toEqual([read.sourceKey]);
  });
});
