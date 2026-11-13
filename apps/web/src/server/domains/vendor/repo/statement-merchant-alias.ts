import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withSnapshotWriteDatabase } from "~/server/db/helpers";
import { vendor } from "~/server/db/retained-tables";
import { merchantVendorInferenceFor } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { executeEntity } from "~/server/entity-kernel";
import type { KernelServicesFor } from "~/server/entity-kernel/adapter";
import { resolveNames } from "~/server/entity-kernel/resolve";

/**
 * Add a statement's raw merchant string as an alias of the one live Vendor
 * named `vendorName`. Refuses when the name is ambiguous or missing, the
 * string already names or contains-matches a Vendor, or confirmed allocations
 * tie the string to another Vendor. Rechecked inside the write: a concurrent
 * merge leaves the survivor holding the name, and a concurrent Vendor edit
 * fails this snapshot's update, which retries and re-resolves rather than
 * overwriting the member's aliases.
 */
export async function aliasStatementMerchant(
  db: Database,
  input: {
    merchant: string;
    vendorName: string;
    actor: ActorContext;
    servicesFor: KernelServicesFor;
  },
): Promise<boolean> {
  return withSnapshotWriteDatabase(
    db,
    async (txDb) => {
      const [named, raw] = await resolveNames(
        txDb,
        "vendor",
        [{ name: input.vendorName }, { name: input.merchant }],
        { create: false },
      );
      if (!named?.row || named.candidates.length) return false;
      if (!raw || raw.row || raw.candidates.length) return false;
      const history = await merchantVendorInferenceFor(txDb, input.merchant);
      const target = parseShortcodeFor("vendor", named.row.shortcode);
      if (
        history.status === "ambiguous" ||
        history.candidates.some((candidate) => candidate.vendorId !== target)
      )
        return false;
      const [current] = await getDb(txDb)
        .select({ aliases: vendor.aliases })
        .from(vendor)
        .where(eq(vendor.id, named.row.id));
      if (!current) return false;
      await executeEntity(
        { ...input.servicesFor(txDb), actorContext: input.actor },
        {
          action: "update",
          entity: "vendor",
          id: target,
          data: { aliases: [...current.aliases, input.merchant] },
        },
      );
      return true;
    },
    { isolationLevel: "repeatable read" },
  );
}
