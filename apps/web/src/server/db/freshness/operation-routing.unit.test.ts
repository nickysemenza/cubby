import { buildActorContext } from "@cubby/schemas/context";
import { testUserId } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { signJWT } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

import { withCfEnv } from "~/server/cf-env";
import { createDatabase } from "~/server/db/database-runtime";
import { readPolicyFor } from "~/server/db/read-policy";
import { getAuthSecret } from "~/server/http/auth-configuration";
import {
  requireActor,
  selectOperationContext,
} from "~/server/http/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { notifyDatabaseChanges } from "./client";
import {
  memberWriteCookie,
  readMemberMarker,
  recordDatabaseWrite,
  registerFreshnessMember,
  withMemberFreshness,
} from "./member-marker";

const db = createDatabase(() => {
  throw new Error("strong database must stay lazy");
});
const cachedDb = createDatabase(() => {
  throw new Error("cached database must stay lazy");
});
const routing = { cachedDb, readMarker: readMemberMarker };
const context = (label: string, channel: "web" | "api" | "mcp" = "web") => {
  const userId = testUserId(label);
  return {
    ...requireActor(createTestRequestContext(db, { auth: { userId } })),
    actorContext: buildActorContext(userId, channel),
  };
};

// Member identity and financial reads are dangerous rules: an invalid or cross-member
// marker cannot downgrade an authoritative decision or another member's reads.
describe("member read routing", () => {
  it("keeps API and MCP strong without a valid marker, while an idle browser can cache", async () => {
    for (const channel of ["web", "api", "mcp"] as const) {
      const selected = await selectOperationContext(
        context(channel, channel),
        "context",
        routing,
      );
      expect(selected.db).toBe(channel === "web" ? cachedDb : db);
    }
  });
  it("validates signatures, member and session, and isolates one member's write from others", async () => {
    const writer = context("writer");
    const other = context("other");
    const cookie = await withMemberFreshness(async () => {
      registerFreshnessMember(writer.auth);
      await recordDatabaseWrite("entity.mutate");
      return memberWriteCookie();
    });
    if (!cookie) throw new Error("Expected signed write cookie");
    expect(cookie).toContain("SameSite=Lax");
    writer.headers.set("cookie", cookie.split(";")[0]!);
    expect(
      (await selectOperationContext(writer, "context", routing)).readConsistency
        .reason,
    ).toBe("fresh-after-write");
    expect((await selectOperationContext(other, "context", routing)).db).toBe(
      cachedDb,
    );
    other.headers.set("cookie", writer.headers.get("cookie")!);
    expect(
      (await selectOperationContext(other, "context", routing)).readConsistency
        .reason,
    ).toBe("invalid-marker");
    const differentSession = {
      ...writer,
      auth: { ...writer.auth, sessionId: "other-session" },
    };
    expect(
      (await selectOperationContext(differentSession, "context", routing))
        .readConsistency.reason,
    ).toBe("invalid-marker");
    writer.headers.set("cookie", writer.headers.get("cookie")! + "tampered");
    expect((await selectOperationContext(writer, "context", routing)).db).toBe(
      db,
    );
  });
  it("never lets a cached member context downgrade money entry, mutations or invalidation refetches", async () => {
    const browser = context("financial");
    expect(
      (
        await selectOperationContext(
          browser,
          readPolicyFor("entity.detail", "query", "expense"),
          routing,
        )
      ).db,
    ).toBe(db);
    expect(
      (
        await selectOperationContext(
          browser,
          readPolicyFor("entity.mutate", "mutation"),
          routing,
        )
      ).db,
    ).toBe(db);
    browser.headers.set("x-cubby-read-consistency", "strong");
    expect(
      (await selectOperationContext(browser, "context", routing))
        .readConsistency.reason,
    ).toBe("invalidation-refetch");
  });
  it("rejects future and expired claims and verifies against the current binding secret", async () => {
    const member = context("marker-security");
    const payload = {
      purpose: "cubby-last-write",
      ...member.auth,
      lastWriteAt: Date.now(),
    };
    for (const token of [
      await signJWT(
        { ...payload, lastWriteAt: Date.now() + 60_000 },
        getAuthSecret(),
        90,
      ),
      await signJWT(payload, getAuthSecret(), -10),
    ]) {
      member.headers.set("x-cubby-read-marker", token);
      expect(await readMemberMarker(member.headers, member.auth)).toEqual({
        kind: "invalid",
      });
    }
    member.headers.set(
      "x-cubby-read-marker",
      await signJWT(payload, getAuthSecret(), 90),
    );
    expect((await readMemberMarker(member.headers, member.auth)).kind).toBe(
      "valid",
    );
    await withCfEnv(
      fromPartial<Env>({
        BETTER_AUTH_SECRET: "synthetic-rotated-auth-secret-for-markers",
        NODE_ENV: "production",
      }),
      async () => {
        expect(await readMemberMarker(member.headers, member.auth)).toEqual({
          kind: "invalid",
        });
        await withMemberFreshness(async () => {
          registerFreshnessMember(member.auth);
          await recordDatabaseWrite("entity.mutate");
          expect(await memberWriteCookie()).toContain("; Secure");
        });
      },
    );
  });
  it("allows an API client to retain a signed marker past the strong-read window", async () => {
    const api = context("idle-api-member", "api");
    const lastWriteAt = Date.now() - 91_000;
    const token = await signJWT(
      { purpose: "cubby-last-write", ...api.auth, lastWriteAt },
      getAuthSecret(),
      86400,
    );
    api.headers.set("x-cubby-read-marker", token);
    expect((await selectOperationContext(api, "context", routing)).db).toBe(
      cachedDb,
    );
  });
  it("background notifications have no member write marker", async () => {
    await recordDatabaseWrite("derived.page");
    expect(await memberWriteCookie()).toBeUndefined();
    await withMemberFreshness(async () => {
      registerFreshnessMember(context("notification-member").auth);
      await notifyDatabaseChanges({ product: ["PRD-A3F2"] });
      expect(await memberWriteCookie()).toBeUndefined();
    });
  });
});
