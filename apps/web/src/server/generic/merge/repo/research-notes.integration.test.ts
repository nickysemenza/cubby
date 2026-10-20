import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { ledgerParty, plant } from "~/server/db/schema";
import {
  createLedgerParty,
  mergeLedgerParties,
} from "~/server/domains/ledger-party/repo/ledger-party";
import { mergePlants } from "~/server/domains/plant/repo/plant";
import { createPlantFixture } from "~/server/testing/repo.fixtures";

const ctx = withTestDb();

// Moving research into ordinary notes must not strand it when either record survives a merge.
it("preserves both Plant notes during a merge", async () => {
  const keeper = await createPlantFixture(
    ctx.db,
    { name: "Synthetic keeper herb", notes: "Keeper research." },
    ctx.actor,
  );
  const donor = await createPlantFixture(
    ctx.db,
    { name: "Synthetic donor herb", notes: "Donor research." },
    ctx.actor,
  );
  await mergePlants(
    ctx.db,
    { keepId: keeper.id, mergeIds: [donor.id] },
    ctx.actor,
  );
  const [saved] = await getDb(ctx.db)
    .select({ notes: plant.notes })
    .from(plant)
    .where(eq(plant.shortcode, keeper.id));
  expect(saved?.notes).toBe("Keeper research.\n\nDonor research.");
});

it("preserves both LedgerParty notes during a merge", async () => {
  const keeper = await createLedgerParty(
    ctx.db,
    {
      name: "Synthetic keeper guest",
      kind: "guest",
      notes: "Keeper research.",
    },
    ctx.actor,
  );
  const donor = await createLedgerParty(
    ctx.db,
    { name: "Synthetic donor guest", kind: "guest", notes: "Donor research." },
    ctx.actor,
  );
  await mergeLedgerParties(
    ctx.db,
    { keepId: keeper.output.id, mergeIds: [donor.output.id] },
    ctx.actor,
  );
  const [saved] = await getDb(ctx.db)
    .select({ notes: ledgerParty.notes })
    .from(ledgerParty)
    .where(eq(ledgerParty.id, keeper.entityId));
  expect(saved?.notes).toBe("Keeper research.\n\nDonor research.");
});
