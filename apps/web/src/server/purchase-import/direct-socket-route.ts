import { and, eq } from "drizzle-orm";

import { getPurchaseImportNamespace } from "~/server/cf-env";
import { vendorAccount } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createRequestContext, requireActor } from "~/server/request-context";

const SOCKET_PATH = "/api/import/agent/socket";

export function isDirectBrowserSocketUpgrade(request: Request): boolean {
  // Workers may consume the Upgrade header before user code sees the request.
  // Route every request for this dedicated endpoint around Start; the handler
  // and Durable Object still reject non-WebSocket requests with HTTP 426.
  return new URL(request.url).pathname === SOCKET_PATH;
}

/**
 * Handle the browser WebSocket before TanStack Start request middleware. A
 * Cloudflare 101 response has immutable headers and a non-standard WebSocket
 * slot; Start's response-header merge mutates those headers and turns a valid
 * upgrade into HTTP 500.
 */
export async function handleDirectBrowserSocketUpgrade(
  request: Request,
): Promise<Response> {
  const accountCode = new URL(request.url).searchParams.get("vendorAccount");
  if (!accountCode)
    return new Response("vendorAccount is required", { status: 400 });

  const context = requireActor(
    await createRequestContext({ headers: request.headers }),
  );
  const party = await context.currentParty();
  if (!party)
    return new Response("Member identity is not configured", { status: 403 });

  const accountId = await resolveOrThrow(
    context.db,
    "vendorAccount",
    accountCode,
  );
  const [owned] = await getDb(context.db)
    .select({ id: vendorAccount.id })
    .from(vendorAccount)
    .where(
      and(
        eq(vendorAccount.id, accountId),
        eq(vendorAccount.ledgerPartyId, party.id),
        notDeleted(vendorAccount),
      ),
    )
    .limit(1);
  if (!owned)
    return new Response("Vendor account is not owned by this member", {
      status: 403,
    });

  const namespace = getPurchaseImportNamespace();
  if (!namespace)
    return new Response("Browser bridge unavailable", { status: 503 });
  const headers = new Headers(request.headers);
  headers.set("x-cubby-ledger-party-id", party.id);
  headers.set("x-cubby-vendor-account-id", owned.id);
  headers.set("x-cubby-user-id", context.actorContext.userId);
  return namespace.getByName(owned.id).fetch(new Request(request, { headers }));
}
