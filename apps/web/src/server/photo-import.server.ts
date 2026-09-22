import { photoImportContract } from "~/contracts/photo-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  finalizePhotoImportRun,
  startPhotoInventoryRun,
} from "~/server/purchase-import/run-service";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { commitPhotoImport } from "~/server/services/photo-import-commit.service";
import { reconcilePhotoImport } from "~/server/services/photo-import-reconcile.service";
import { manifestPhotoImportRouteAdapter } from "~/server/services/photo-import-route.adapter";
import { stagePhotoImport } from "~/server/services/photo-import-stage.service";

export const photoImportHandlers = implementOperationDomain(
  photoImportContract,
  {
    stage: (context, input) => stagePhotoImport(context.db, input),
    commit: (context, input) =>
      commitPhotoImport(context, input, manifestPhotoImportRouteAdapter),
    createRun: async (context, input) => {
      const ledgerPartyId = input.ledgerPartyId
        ? await resolveOrThrow(context.db, "ledgerParty", input.ledgerPartyId)
        : undefined;
      const run = await startPhotoInventoryRun(context.db, {
        ledgerPartyId,
        actorUserId: context.auth.userId,
        notes: input.notes,
      });
      return { runId: run.publicId };
    },
    finalize: (context, input) =>
      finalizePhotoImportRun(context.db, input, context.actorContext),
    reconcile: (context, input) => reconcilePhotoImport(context.db, input),
  },
);
