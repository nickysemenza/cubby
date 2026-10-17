import type { EntityRef } from "@cubby/schemas/entity";
import { vendorId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { workDependencies } from "~/server/generic/work-queue/repo/work-dependencies";

import { advanceVendorHistory } from "./vendor-history";

/** Dependency adapters own eligibility; the generic wake grants no authority. */
const advancements = {
  vendorHistory: async (db: Database, changed?: EntityRef[]) => {
    if (!changed) return advanceVendorHistory(db);
    for (const record of changed)
      if (record.entityKind === "vendor")
        await advanceVendorHistory(db, {
          vendorId: vendorId.parse(record.entityId),
        });
  },
} satisfies Record<
  keyof typeof workDependencies,
  (db: Database, changed?: EntityRef[]) => Promise<void>
>;

export async function advanceAuthorizedWork(
  db: Database,
  changed?: EntityRef[],
) {
  for (const advance of Object.values(advancements)) await advance(db, changed);
}
