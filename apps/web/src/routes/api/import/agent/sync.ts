import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import { dispatchImportRunEvent } from "~/server/purchase-import/dispatch";
import { startOrResumeImportRun } from "~/server/purchase-import/run-service";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/agent/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const body = z
          .object({ vendorAccount: z.string().min(1) })
          .safeParse(await request.json());
        if (!body.success) {
          return Response.json(
            { error: "vendorAccount is required" },
            { status: 400 },
          );
        }
        const party = await context.currentParty();
        if (!party) {
          return Response.json(
            { error: "Member identity is not configured" },
            { status: 403 },
          );
        }
        const accountId = await resolveOrThrow(
          context.db,
          "vendorAccount",
          body.data.vendorAccount,
        );
        const queue = getPurchaseAgentQueue();
        if (!queue) {
          return Response.json(
            { error: "Purchase import agent unavailable" },
            { status: 503 },
          );
        }
        const run = await startOrResumeImportRun(context.db, {
          ledgerPartyId: party.id,
          vendorAccountId: accountId,
          trigger: "manual",
        });
        await dispatchImportRunEvent(context.db, queue, {
          version: 1,
          runId: run.id,
          publicId: run.publicId,
          eventId: run.created
            ? (run.dispatchEventId ?? crypto.randomUUID())
            : crypto.randomUUID(),
          type: run.created ? "start_or_resume" : "retry",
        });
        return Response.json({ runId: run.publicId, resumed: !run.created });
      },
    },
  },
});
