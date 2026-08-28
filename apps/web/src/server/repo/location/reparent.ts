import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type { LocationShortcode } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

import { bulkReparentLocations } from "./crud";

const locationShortcodes = bindShortcodeResolver("location");

/**
 * Bulk reparent, guards and all — shared by the kernel's `location.bulkUpdate`
 * and the `location.bulkUpdateParent` workflow the arrange, sweep and reparent
 * surfaces still call.
 *
 * Deliberately not a declarative `parentId` column patch:
 * `bulkReparentLocations` carries the home-immutability guard, full-tree cycle
 * detection and the stale-row race check, and — the one that would silently
 * corrupt the tree — `parentId: null` means "move to Home", not SQL NULL,
 * matching single-row `updateLocation`. Only the self-parent refusal and the
 * shortcode resolution live here, above it.
 */
export const reparentLocationsInBulk = async (
  db: Database,
  actor: ActorContext,
  requestedIds: readonly LocationShortcode[],
  requestedParentId: LocationShortcode | null,
): Promise<{ updated: number; backgroundBatches: BackgroundBatchRef[] }> => {
  if (requestedParentId && requestedIds.includes(requestedParentId)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Cannot move a location under itself.",
    );
  }
  const ids = [...new Set(await locationShortcodes.all(db, requestedIds))];
  const parentId = requestedParentId
    ? await locationShortcodes.one(db, requestedParentId)
    : null;
  await bulkReparentLocations(db, ids, parentId, actor);
  const backgroundBatches = await runMutationSideEffectsForEntities(
    db,
    ids.map((entityId) => ({
      action: "updated" as const,
      entity: { entityType: "location" as const, entityId },
      source: "location.bulkUpdateParent",
    })),
  );
  return { updated: ids.length, backgroundBatches };
};
