import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/agent/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        // An optional inclusive date range turns the request into an
        // explicit historical backfill instead of an incremental sync.
        const body = z
          .object({
            vendorAccount: z.string().min(1),
            backfill: z
              .object({ from: z.iso.date(), to: z.iso.date() })
              .optional(),
          })
          .safeParse(await request.json());
        if (!body.success) {
          return Response.json(
            {
              error: body.error.issues.map((issue) => issue.message).join("; "),
            },
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
        // Loaded on request: run-service reaches the AI SDK stack, which would
        // otherwise load into every Worker request.
        const [
          { dispatchRunEvent },
          { AccountOccupiedError, startOrResumeRun },
        ] = await Promise.all([
          import("~/server/purchase-import/dispatch"),
          import("~/server/purchase-import/run-service"),
        ]);
        let run: Awaited<ReturnType<typeof startOrResumeRun>>;
        try {
          run = await startOrResumeRun(context.db, {
            ledgerPartyId: party.id,
            vendorAccountId: accountId,
            ...(body.data.backfill
              ? { trigger: "backfill" as const, backfill: body.data.backfill }
              : { trigger: "manual" as const }),
          });
        } catch (error) {
          // A refused backfill (occupied account, invalid range) or an account
          // another run holds is the member's to act on; return the reason.
          if (!body.data.backfill && !(error instanceof AccountOccupiedError))
            throw error;
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 409 },
          );
        }
        await dispatchRunEvent(context.db, queue, {
          version: 1,
          runId: run.id,
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
