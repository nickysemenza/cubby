import { DERIVED_SNAPSHOT_PASS } from "~/server/generic/derived/repo/snapshot-state";
import { rebuildSnapshotPage } from "~/server/generic/derived/service/rebuild";
import { definePass } from "~/server/kernel/api";

import { derivedComputes } from "./derived-computes";

export const derivedSnapshotPass = definePass({
  name: DERIVED_SNAPSHOT_PASS,
  run: (db, cursor, claim) =>
    rebuildSnapshotPage(db, derivedComputes, cursor, claim),
});
