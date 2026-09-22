import { buildActorContext } from "@cubby/schemas/context";
import { testUserId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { Database } from "~/server/db";
import {
  requireActor,
  selectOperationContext,
  type AuthenticatedRequestContext,
  type DatabaseReadRouting,
} from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import type { DatabaseFreshness } from "./state";
import { databaseFreshness } from "./state";

let freshness: DatabaseFreshness | null = null;

const db = new Database(() => {
  throw new Error("strong database must stay lazy");
});
const boundedStaleDb = new Database(() => {
  throw new Error("cached database must stay lazy");
});
const routing: DatabaseReadRouting = {
  cachedDb: boundedStaleDb,
  readFreshness: async () => freshness,
};

const user = (label: string) => testUserId(`freshness-${label}`);

const authenticatedContext = (
  channel: "web" | "api" | "mcp",
  label: string,
): AuthenticatedRequestContext => {
  const id = user(label);
  const context = requireActor(
    createTestRequestContext(db, { auth: { userId: id } }),
  );
  return {
    ...context,
    actorContext: buildActorContext(id, channel),
    requestOrigin: channel === "web" ? "ui" : channel,
  };
};

beforeEach(() => {
  freshness = databaseFreshness(0);
});

describe("shared database freshness operation routing", () => {
  it("uses cached reads before a write, then makes every household caller strong until expiry", async () => {
    const ui = authenticatedContext("web", "ui");
    const api = authenticatedContext("api", "api");
    const mcp = authenticatedContext("mcp", "mcp");

    const warm = await selectOperationContext(ui, "context", routing);
    expect(warm.db).toBe(boundedStaleDb);
    expect(warm.readDb).toBe(boundedStaleDb);

    freshness = databaseFreshness(Date.now());
    const secondUser = await selectOperationContext(api, "context", routing);
    const mcpRead = await selectOperationContext(mcp, "context", routing);
    expect(secondUser.db).toBe(db);
    expect(mcpRead.db).toBe(db);

    freshness = databaseFreshness(Date.now() - 91_000);
    const expired = await selectOperationContext(api, "context", routing);
    expect(expired.db).toBe(boundedStaleDb);
  });

  it("keeps mutations strong and does not reuse a decision from an earlier operation", async () => {
    const context = authenticatedContext("web", "sequential");

    const cached = await selectOperationContext(context, "context", routing);
    expect(cached.db).toBe(boundedStaleDb);

    freshness = databaseFreshness(Date.now());
    const mutation = await selectOperationContext(context, "strong", routing);
    const laterRead = await selectOperationContext(context, "context", routing);
    expect(mutation.db).toBe(db);
    expect(mutation.readConsistency).toEqual({
      consistency: "strong",
      reason: "authoritative-operation",
    });
    expect(laterRead.db).toBe(db);
  });
});
