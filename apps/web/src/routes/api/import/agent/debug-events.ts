import { createFileRoute } from "@tanstack/react-router";
import { and, eq, inArray } from "drizzle-orm";

import { purchaseImportDebugEventsRequest } from "~/lib/purchase-import-debug";
import { importRun, importRunOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createRequestContext, requireActor } from "~/server/request-context";

const DEBUG_EVENT_KIND = "__debug_event";

export const Route = createFileRoute("/api/import/agent/debug-events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const party = await context.currentParty();
        if (!party) {
          return Response.json(
            { error: "Member identity is not configured" },
            { status: 403 },
          );
        }
        const parsed = purchaseImportDebugEventsRequest.safeParse(
          await request.json(),
        );
        if (!parsed.success) {
          return Response.json(
            { error: "Invalid debug event batch" },
            { status: 400 },
          );
        }
        const database = getDb(context.db);
        const runIds = [
          ...new Set(parsed.data.events.map((event) => event.runId)),
        ];
        const ownedRuns = await database
          .select({ id: importRun.id })
          .from(importRun)
          .where(
            and(
              inArray(importRun.id, runIds),
              eq(importRun.ledgerPartyId, party.id),
              // A party peer cannot attach arbitrary device metadata to the
              // run started by another actor.
              eq(importRun.actorUserId, context.auth.userId),
            ),
          );
        const ownedRunIds = new Set(ownedRuns.map((run) => run.id));
        if (runIds.some((runId) => !ownedRunIds.has(runId))) {
          return Response.json(
            { error: "Import run was not found" },
            { status: 404 },
          );
        }

        const inserted = await database
          .insert(importRunOperation)
          .values(
            parsed.data.events.map((event) => ({
              runId: event.runId,
              operationId: `${DEBUG_EVENT_KIND}:${event.id}`,
              kind: DEBUG_EVENT_KIND,
              inputFingerprint: event.id,
              state: "completed",
              result: event,
              executor: event.executor ?? null,
              completedAt: new Date(),
            })),
          )
          .onConflictDoNothing()
          .returning({ id: importRunOperation.id });
        return Response.json({ accepted: inserted.length });
      },
    },
  },
});
