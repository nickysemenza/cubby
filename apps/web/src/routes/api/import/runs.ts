import type { EntityId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";

import { importRunsResponse } from "~/lib/purchase-import-run-detail";
import {
  listProductImportRuns,
  listImportRuns,
  resolveProductImportTarget,
  resolvePurchaseImportTarget,
} from "~/server/purchase-import/run-target";
import { createRequestContext, requireActor } from "~/server/request-context";

export {
  importRunsError,
  importRunsResponse,
  type ImportRunSummary,
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
        const productShortcode = new URL(request.url).searchParams.get(
          "productId",
        );
        if (purchaseShortcode && productShortcode) {
          return Response.json(
            { error: "Choose either a Purchase or a Product" },
            { status: 400 },
          );
        }
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
        let productId: EntityId<"product"> | undefined;
        if (productShortcode) {
          productId =
            (await resolveProductImportTarget(context.db, productShortcode)) ??
            undefined;
          if (!productId) {
            return Response.json(
              { error: "Product was not found" },
              { status: 404 },
            );
          }
        }
        const runs = productId
          ? await listProductImportRuns(context.db, party.id, productId)
          : await listImportRuns(context.db, party.id, purchaseId);
        return Response.json(
          importRunsResponse.parse({
            runs: runs.map((run) => ({
              vendorAccountLabel: run.vendorAccountLabel,
              vendorName: run.vendorName,
              trigger: run.trigger,
              purpose: run.purpose,
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
