/**
 * The companion durable object's ONLY window onto `Device` rows.
 *
 * Deliberately its own leaf module rather than a re-export from
 * `repo/device.ts`: that file (like every generic entity repo) pulls in
 * `~/server/repo/removal` and the `database-helpers` barrel, both of which
 * already have a real (pre-existing, otherwise-harmless) cycle back through
 * `repo/image.ts` → `repo/audit-log.ts` → `repo/entity-display-image.ts` →
 * `repo/image-processing.ts`. That cycle is silent everywhere else because
 * nothing needs a cyclic binding's value while its module is still mid
 * -evaluation — except `repo/device.ts`'s own top-level `listScaffold(...)`
 * call, which reads `dataQualitySortResolver` off `data-quality/sql.ts`
 * synchronously at import time. Reaching `repo/device.ts` from
 * `image-processing-history.ts`/`durable-object.ts` (which sit inside that
 * same cycle) reliably lands that read before `sql.ts` has finished, so the
 * import throws `dataQualitySortResolver is not a function`. This module
 * only imports narrow, leaf-level helpers (never the `database-helpers`
 * barrel, never `removal`, never `repo/device.ts`) specifically to stay out
 * of that cycle.
 */
import { generateShortcode } from "@cubby/shared";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { device } from "~/server/db/schema";
import { unwrapDb, withTransaction } from "~/server/repo/database-helpers/core";
import { notDeleted } from "~/server/repo/database-helpers/query";

/** How many fresh shortcodes to try before giving up — mirrors
 * `shortcode-utils.ts`'s `MAX_RETRIES`, which this intentionally does not
 * import (see the module doc comment). */
const MAX_SHORTCODE_RETRIES = 10;

type DeviceParticipation = { automaticWork: boolean; remotePaused: boolean };

const selectByInstallationId = (
  tx: DrizzleTransaction,
  installationId: string,
) =>
  tx
    .select({ id: device.id })
    .from(device)
    .where(and(eq(device.installationId, installationId), notDeleted(device)))
    .limit(1);

/**
 * Companion transport surface, not a generic CRUD path. Every native hello
 * lands here: create the row on first contact (using the hello's own
 * `participation.automaticWork` and suggested name) or refresh liveness and
 * the device-owned `automaticWork` switch on an existing one. A household edit
 * owns the saved name after creation.
 */
export async function upsertDeviceFromHello(
  db: Database,
  hello: {
    installationId: string;
    name: string;
    platform: "ios" | "macos";
    appVersion: string | null;
    osVersion: string | null;
    automaticWork: boolean;
  },
): Promise<DeviceParticipation> {
  return withTransaction(db, async (tx) => {
    const now = new Date();
    const [existing] = await selectByInstallationId(tx, hello.installationId);
    let id = existing?.id;
    if (!id) {
      // Bare `.onConflictDoNothing()` — no target — applies to ANY
      // conflicting unique constraint on the table (the partial
      // `installationId` index or a freak shortcode collision), same as
      // `database-helpers/crud.ts`'s `findOrCreate` does for every other
      // entity; this file just can't import that helper (see doc comment).
      for (let attempt = 0; attempt < MAX_SHORTCODE_RETRIES; attempt++) {
        const [created] = await tx
          .insert(device)
          .values({
            shortcode: generateShortcode("device"),
            installationId: hello.installationId,
            name: hello.name,
            platform: hello.platform,
            appVersion: hello.appVersion,
            osVersion: hello.osVersion,
            automaticWork: hello.automaticWork,
            remotePaused: false,
            lastSeenAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: device.id });
        if (created) {
          id = created.id;
          break;
        }
        // Lost the race, or the minted shortcode collided: another hello for
        // the same installationId may have just won — check for it before
        // assuming it was a shortcode collision worth retrying.
        const [winner] = await selectByInstallationId(tx, hello.installationId);
        if (winner) {
          id = winner.id;
          break;
        }
      }
      if (!id)
        throw new Error(
          `Could not create Device ${hello.installationId}: shortcode retries exhausted`,
        );
    }
    const [updated] = await tx
      .update(device)
      .set({
        appVersion: hello.appVersion,
        osVersion: hello.osVersion,
        // The device owns its own switch; the web owns `remotePaused`.
        automaticWork: hello.automaticWork,
        lastSeenAt: now,
      })
      .where(eq(device.id, id))
      .returning({
        automaticWork: device.automaticWork,
        remotePaused: device.remotePaused,
      });
    // SAFETY: `id` was just found-or-created live, in the same transaction.
    return updated!;
  });
}

/** `assignImageProcessingExecutor` re-reads this inside its own transaction
 * so a `remotePaused`/`automaticWork` flip after hello, but before dispatch,
 * still refuses the assignment and new activity uses the saved display name. */
export async function getDeviceParticipation(
  db: Database | DrizzleTransaction,
  installationId: string,
): Promise<(DeviceParticipation & { name: string }) | null> {
  const [row] = await unwrapDb(db)
    .select({
      name: device.name,
      automaticWork: device.automaticWork,
      remotePaused: device.remotePaused,
    })
    .from(device)
    .where(and(eq(device.installationId, installationId), notDeleted(device)))
    .limit(1);
  return row ?? null;
}
