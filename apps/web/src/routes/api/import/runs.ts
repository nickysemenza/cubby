import type { EntityId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  listPurchaseImportRuns,
  resolvePurchaseImportTarget,
} from "~/server/purchase-import/run-target";
import { createRequestContext, requireActor } from "~/server/request-context";

export const purchaseImportRunSummary = z.object({
  id: z.uuid(),
  vendorAccountLabel: z.string().nullable(),
  vendorName: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  ordersSeen: z.number().int(),
  imported: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  failureCode: z.string().nullable(),
  estimatedCost: z.number(),
});
export type PurchaseImportRunSummary = z.infer<typeof purchaseImportRunSummary>;

export const purchaseImportRunsResponse = z.object({
  runs: z.array(purchaseImportRunSummary),
});
export const purchaseImportRunsError = z.object({ error: z.string() });

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
              ...run,
              startedAt: run.startedAt.toISOString(),
              endedAt: run.endedAt?.toISOString() ?? null,
            })),
          }),
        );
      },
    },
  },
});
