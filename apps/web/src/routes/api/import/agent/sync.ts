import { browserBridgeRequest } from "@cubby/schemas/purchase-import";
import { vendorAgentHints } from "@cubby/schemas/vendor-import-fields";
import { createFileRoute } from "@tanstack/react-router";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getPurchaseImportNamespace } from "~/server/cf-env";
import {
  importRun,
  ledgerParty,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
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
        const [account] = await getDb(context.db)
          .select({
            id: vendorAccount.id,
            vendorId: vendorAccount.vendorId,
            hints: vendor.agentHints,
            website: vendor.website,
            browserDomains: vendor.browserDomains,
          })
          .from(vendorAccount)
          .innerJoin(
            vendor,
            and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
          )
          .innerJoin(
            ledgerParty,
            and(
              eq(ledgerParty.id, vendorAccount.ledgerPartyId),
              eq(ledgerParty.id, party.id),
              notDeleted(ledgerParty),
            ),
          )
          .where(
            and(eq(vendorAccount.id, accountId), notDeleted(vendorAccount)),
          )
          .limit(1);
        if (!account) {
          return Response.json(
            { error: "Vendor account is not owned by this member" },
            { status: 403 },
          );
        }
        const startUrl =
          vendorAgentHints.parse(account.hints).ordersListUrl ??
          account.website;
        if (!startUrl) {
          return Response.json(
            {
              error: "This vendor needs an orders-list URL before it can sync",
            },
            { status: 409 },
          );
        }
        const allowedHosts =
          account.browserDomains.length > 0
            ? account.browserDomains
            : [new URL(startUrl).hostname];
        const [run] = await getDb(context.db)
          .insert(importRun)
          .values({
            ledgerPartyId: party.id,
            vendorAccountId: account.id,
            trigger: "manual",
            agentSessionId: crypto.randomUUID(),
          })
          .returning({ id: importRun.id });
        if (!run) throw new Error("Import run was not created");
        await getDb(context.db)
          .update(vendorAccount)
          .set({
            status: "active",
            lastRunAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(vendorAccount.id, account.id));
        const command = browserBridgeRequest.parse({
          id: crypto.randomUUID(),
          runID: run.id,
          deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
          operation: {
            type: "navigate",
            url: startUrl,
            allowedHosts,
          },
        });
        const namespace = getPurchaseImportNamespace();
        if (!namespace) {
          return Response.json(
            { error: "Browser bridge unavailable" },
            { status: 503 },
          );
        }
        await namespace.getByName(account.id).enqueue(command);
        return Response.json({ runId: run.id, commandId: command.id });
      },
    },
  },
});
