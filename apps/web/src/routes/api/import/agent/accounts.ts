import { createFileRoute } from "@tanstack/react-router";
import { and, eq, inArray } from "drizzle-orm";

import { ledgerParty, vendorAccount } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/agent/accounts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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
        const accounts = await getDb(context.db)
          .select({
            id: vendorAccount.shortcode,
            label: vendorAccount.label,
            ledgerPartyId: ledgerParty.shortcode,
            browser: vendorAccount.browser,
          })
          .from(vendorAccount)
          .innerJoin(
            ledgerParty,
            and(
              eq(ledgerParty.id, vendorAccount.ledgerPartyId),
              eq(ledgerParty.id, party.id),
              notDeleted(ledgerParty),
            ),
          )
          .where(
            and(
              inArray(vendorAccount.status, [
                "active",
                "paused_auth",
                "paused_offline",
              ]),
              notDeleted(vendorAccount),
            ),
          )
          .orderBy(vendorAccount.label);
        return Response.json({ accounts });
      },
    },
  },
});
