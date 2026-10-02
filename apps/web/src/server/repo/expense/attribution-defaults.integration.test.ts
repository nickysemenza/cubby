import {
  type LedgerPartyShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { buildEntity } from "tooling/factories/build";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { loadVendorAttributionDefaults } from "~/server/repo/expense/attribution-defaults";
import { createExpense, updateExpense } from "~/server/repo/expense/crud";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { makeExpenseInput } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

type Shares = Array<{ partyId: LedgerPartyShortcode | null; weight: number }>;

describe("vendor attribution defaults", () => {
  const ctx = withTestDb();

  const party = async (name: string) =>
    (
      await createLedgerParty(
        ctx.db,
        { name, kind: "member", notes: null },
        TEST_ACTOR,
      )
    ).output.id;

  const charge = async (
    vendorName: string,
    date: string,
    attribution: { beneficiaries?: Shares; funders?: Shares },
  ) => {
    const vendorId = await findOrCreateVendor(ctx.db, vendorName);
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date,
    });
    return createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({
          name: `Line ${date}`,
          date,
          purchaseId: parseShortcodeFor("purchase", purchase.shortcode),
          beneficiaries: attribution.beneficiaries ?? [],
          funders: attribution.funders ?? [],
        }),
      ),
      TEST_ACTOR,
    );
  };

  it("returns the latest dated attributed set for the vendor, both roles", async () => {
    const [a, b, c] = await Promise.all([
      party("Prefill A"),
      party("Prefill B"),
      party("Prefill C"),
    ]);
    await charge("Prefill Hardware", "2026-01-01", {
      beneficiaries: [{ partyId: a, weight: 1 }],
    });
    await charge("Prefill Hardware", "2026-03-01", {
      beneficiaries: [
        { partyId: b, weight: 2 },
        { partyId: c, weight: 1 },
      ],
      funders: [{ partyId: a, weight: 1 }],
    });
    // Newer but unattributed: must not blank the prefill.
    await charge("Prefill Hardware", "2026-06-01", {});
    // Another vendor's newer set must not leak.
    await charge("Prefill Other", "2026-07-01", {
      beneficiaries: [{ partyId: c, weight: 1 }],
    });

    const result = await loadVendorAttributionDefaults(
      ctx.db,
      "  Prefill Hardware ",
    );
    expect(
      [...result.beneficiaries].sort((x, y) => y.weight - x.weight),
    ).toEqual([
      { partyId: b, weight: 2 },
      { partyId: c, weight: 1 },
    ]);
    expect(result.funders).toEqual([{ partyId: a, weight: 1 }]);
  });

  it("ignores cleared attributions and unknown vendors", async () => {
    const a = await party("Prefill Cleared");
    const created = await charge("Prefill Cleared Vendor", "2026-02-01", {
      beneficiaries: [{ partyId: a, weight: 1 }],
    });
    expect(
      (await loadVendorAttributionDefaults(ctx.db, "Prefill Cleared Vendor"))
        .beneficiaries,
    ).toHaveLength(1);

    await updateExpense(
      ctx.db,
      created.output.id,
      { beneficiaries: [] },
      TEST_ACTOR,
    );
    expect(
      await loadVendorAttributionDefaults(ctx.db, "Prefill Cleared Vendor"),
    ).toEqual({ beneficiaries: [], funders: [] });
    expect(
      await loadVendorAttributionDefaults(ctx.db, "No such vendor"),
    ).toEqual({ beneficiaries: [], funders: [] });
  });
});
