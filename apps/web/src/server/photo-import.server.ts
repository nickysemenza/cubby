import { photoImportContract } from "~/contracts/photo-import.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
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
    reconcile: (context, input) => reconcilePhotoImport(context.db, input),
  },
);
