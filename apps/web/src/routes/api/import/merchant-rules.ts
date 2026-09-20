import { confirmMerchantVendorRuleInput } from "@cubby/schemas/purchase-import";
import { createFileRoute } from "@tanstack/react-router";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { merchantVendorRule, vendor } from "~/server/db/schema";
import { confirmMerchantVendorRule } from "~/server/purchase-import/hunts";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createRequestContext, requireActor } from "~/server/request-context";

export const merchantRulesResponse = z.object({
  rules: z.array(
    z.object({
      merchant: z.string(),
      vendorId: z.string(),
      vendorName: z.string(),
    }),
  ),
  vendors: z.array(z.object({ shortcode: z.string(), name: z.string() })),
});

const load = async (request: Request) => {
  const context = requireActor(
    await createRequestContext({ headers: request.headers }),
  );
  const party = await context.currentParty();
  if (!party) return { context, party: null, payload: null };
  const [rules, vendors] = await Promise.all([
    getDb(context.db)
      .select({
        merchant: merchantVendorRule.normalizedMerchant,
        vendorId: vendor.shortcode,
        vendorName: vendor.name,
      })
      .from(merchantVendorRule)
      .innerJoin(
        vendor,
        and(eq(vendor.id, merchantVendorRule.vendorId), notDeleted(vendor)),
      )
      .where(eq(merchantVendorRule.ledgerPartyId, party.id))
      .orderBy(asc(merchantVendorRule.normalizedMerchant)),
    getDb(context.db)
      .select({ shortcode: vendor.shortcode, name: vendor.name })
      .from(vendor)
      .where(notDeleted(vendor))
      .orderBy(asc(vendor.name)),
  ]);
  return {
    context,
    party,
    payload: merchantRulesResponse.parse({ rules, vendors }),
  };
};

export const Route = createFileRoute("/api/import/merchant-rules")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const loaded = await load(request);
        return loaded.party
          ? Response.json(loaded.payload)
          : Response.json(
              { error: "Member identity is not configured" },
              { status: 403 },
            );
      },
      POST: async ({ request }) => {
        const loaded = await load(request);
        if (!loaded.party)
          return Response.json(
            { error: "Member identity is not configured" },
            { status: 403 },
          );
        const input = confirmMerchantVendorRuleInput.safeParse(
          await request.json(),
        );
        if (!input.success)
          return Response.json(
            { error: "Merchant and vendor are required" },
            { status: 400 },
          );
        await confirmMerchantVendorRule(
          loaded.context.db,
          input.data,
          loaded.context.actorContext,
        );
        const refreshed = await load(request);
        return Response.json(refreshed.payload);
      },
    },
  },
});
