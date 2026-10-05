import { runEntityId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { and, eq, inArray } from "drizzle-orm";

import { purchaseImportDebugEventsRequest } from "~/lib/purchase-import-debug";
import { run as runTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertDebugEventOperations } from "~/server/repo/run-operation";
import { createRequestContext, requireActor } from "~/server/request-context";

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
          .select({ id: runTable.id })
          .from(runTable)
          .where(
            and(
              inArray(
                runTable.id,
                runIds.map((id) => runEntityId.parse(id)),
              ),
              eq(runTable.ledgerPartyId, party.id),
              // A party peer cannot attach arbitrary device metadata to the
              // run started by another actor.
              eq(runTable.actorUserId, context.auth.userId),
            ),
          );
        const ownedRunIds = new Set<string>(ownedRuns.map((run) => run.id));
        if (runIds.some((runId) => !ownedRunIds.has(runId))) {
          return Response.json(
            { error: "Import run was not found" },
            { status: 404 },
          );
        }

        const accepted = await insertDebugEventOperations(
          database,
          parsed.data.events,
        );
        return Response.json({ accepted });
      },
    },
  },
});
