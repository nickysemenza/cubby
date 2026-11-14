import type { Database } from "~/server/db/database";
import type { DerivedComputes } from "~/server/generic/derived/repo/compute";
import {
  rebuildActive,
  requestDerivedRebuild,
} from "~/server/generic/derived/repo/rebuild";
import { DERIVED_SNAPSHOT_PASS } from "~/server/generic/derived/repo/snapshot-state";
import { rebuildSnapshotPage } from "~/server/generic/derived/service/rebuild";
import { createKernel, defineModule, definePass } from "~/server/kernel/api";
import { runOnePass } from "~/server/kernel/pass";

/** Existing database journeys drive the real claim and atomic Pass publication. */
export async function runSnapshotPage(
  db: Database,
  computes: DerivedComputes,
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (options.force) await requestDerivedRebuild(db);
  const pass = definePass({
    name: DERIVED_SNAPSHOT_PASS,
    run: (database, cursor, claim) =>
      rebuildSnapshotPage(database, computes, cursor, claim),
  });
  const kernel = createKernel([
    defineModule({ name: "snapshot-fixture", passes: [pass] }),
  ]);
  const ran = await runOnePass(db, kernel.registry);
  const active = await rebuildActive(db);
  // Another runtime holds the claim: wait for its page instead of spending
  // the caller's page budget on misses.
  if (!ran && active) await new Promise((resolve) => setTimeout(resolve, 50));
  return active;
}
