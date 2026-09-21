import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { MCP_RESOURCE } from "~/lib/auth-constants";
import {
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import {
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";

describe("purchase agent OAuth client provisioning", () => {
  const ctx = withTestDb();

  it("transactionally preserves consent, PKCE, resource, and client linkage", async () => {
    await ensurePurchaseAgentOAuthClient(ctx.db);
    await ensurePurchaseAgentOAuthClient(ctx.db);

    const database = getDb(ctx.db);
    const [client] = await database
      .select({
        skipConsent: oauthClient.skipConsent,
        requirePKCE: oauthClient.requirePKCE,
      })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, PURCHASE_AGENT_OAUTH_CLIENT_ID));
    const resources = await database
      .select({ identifier: oauthResource.identifier })
      .from(oauthResource)
      .where(eq(oauthResource.identifier, MCP_RESOURCE));
    const links = await database
      .select({ resourceId: oauthClientResource.resourceId })
      .from(oauthClientResource)
      .where(eq(oauthClientResource.clientId, PURCHASE_AGENT_OAUTH_CLIENT_ID));

    expect(client).toEqual({ skipConsent: false, requirePKCE: true });
    expect(resources).toEqual([{ identifier: MCP_RESOURCE }]);
    expect(links).toEqual([{ resourceId: MCP_RESOURCE }]);
  });
});
