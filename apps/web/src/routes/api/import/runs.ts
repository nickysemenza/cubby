import type { EntityId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";

import { purchaseImportRunsResponse } from "~/lib/purchase-import-run-detail";
import {
  listPurchaseImportRuns,
  resolvePurchaseImportTarget,
} from "~/server/purchase-import/run-target";
import { createRequestContext, requireActor } from "~/server/request-context";

export {
  purchaseImportRunsError,
  purchaseImportRunsResponse,
  type PurchaseImportRunSummary,
} from "~/lib/purchase-import-run-detail";

export const Route = createFileRoute("/api/import/runs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const party = await context.currentParty();
        if (!party) {
          return Response.json(
            {
              error: "This login is not linked to a member ledger party yet.",
            },
            { status: 403 },
          );
        }
        const purchaseShortcode = new URL(request.url).searchParams.get(
          "purchaseId",
        );
        let purchaseId: EntityId<"purchase"> | undefined;
        if (purchaseShortcode) {
          purchaseId =
            (await resolvePurchaseImportTarget(
              context.db,
              purchaseShortcode,
            )) ?? undefined;
          if (!purchaseId) {
            return Response.json(
              { error: "Purchase was not found" },
              { status: 404 },
            );
          }
        }
        const runs = await listPurchaseImportRuns(
          context.db,
          party.id,
          purchaseId,
        );
        return Response.json(
          purchaseImportRunsResponse.parse({
            runs: runs.map((run) => ({
              publicId: run.publicId,
              vendorAccountLabel: run.vendorAccountLabel,
              vendorName: run.vendorName,
              trigger: run.trigger,
              status: run.status,
              startedAt: run.startedAt.toISOString(),
              endedAt: run.endedAt?.toISOString() ?? null,
              ordersSeen: run.ordersSeen,
              imported: run.imported,
              updated: run.updated,
              skipped: run.skipped,
              failureCode: run.failureCode,
              estimatedCost: run.estimatedCost,
            })),
          }),
        );
      },
    },
  },
});
