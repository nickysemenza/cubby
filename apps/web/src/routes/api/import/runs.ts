import { createFileRoute } from "@tanstack/react-router";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { aiUsage, importRun, vendor, vendorAccount } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
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
        const runs = await getDb(context.db)
          .select({
            id: importRun.id,
            vendorAccountLabel: vendorAccount.label,
            vendorName: vendor.name,
            trigger: importRun.trigger,
            status: importRun.status,
            startedAt: importRun.startedAt,
            endedAt: importRun.endedAt,
            ordersSeen: importRun.ordersSeen,
            imported: importRun.imported,
            updated: importRun.updated,
            skipped: importRun.skipped,
            failureCode: importRun.failureCode,
            estimatedCost: sql<number>`coalesce(sum(${aiUsage.estimatedCost}), 0)`,
          })
          .from(importRun)
          .leftJoin(
            vendorAccount,
            and(
              eq(vendorAccount.id, importRun.vendorAccountId),
              notDeleted(vendorAccount),
            ),
          )
          .leftJoin(
            vendor,
            and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
          )
          .leftJoin(
            aiUsage,
            and(
              eq(aiUsage.jobKind, "purchase_import_run"),
              eq(aiUsage.jobId, sql<string>`${importRun.id}::text`),
              notDeleted(aiUsage),
            ),
          )
          .where(eq(importRun.ledgerPartyId, party.id))
          .groupBy(importRun.id, vendorAccount.label, vendor.name)
          .orderBy(desc(importRun.startedAt))
          .limit(20);
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
