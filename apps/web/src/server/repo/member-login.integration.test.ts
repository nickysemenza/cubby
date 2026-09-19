import { testUserId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { user } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createLedgerParty } from "~/server/repo/ledger-party";
import {
  listMemberLogins,
  setMemberLoginParty,
} from "~/server/repo/member-login";

describe("member login ownership", () => {
  const ctx = withTestDb();

  it("links, moves, and unlinks a Better Auth user from one member party", async () => {
    const targetUserId = testUserId("member-login-user");
    await getDb(ctx.db).insert(user).values({
      id: targetUserId,
      name: "Household Member",
      email: "member@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const first = await createLedgerParty(
      ctx.db,
      { name: "First Member", kind: "member", notes: null },
      ctx.actor,
    );
    const second = await createLedgerParty(
      ctx.db,
      { name: "Second Member", kind: "member", notes: null },
      ctx.actor,
    );

    await setMemberLoginParty(ctx.db, targetUserId, first.output.id, ctx.actor);
    await setMemberLoginParty(
      ctx.db,
      targetUserId,
      second.output.id,
      ctx.actor,
    );

    const linked = await listMemberLogins(ctx.db);
    expect(
      linked.users.find((authUser) => authUser.id === targetUserId)
        ?.ledgerParty,
    ).toEqual({ shortcode: second.output.id, name: "Second Member" });
    expect(
      linked.parties.find((party) => party.shortcode === first.output.id)
        ?.userId,
    ).toBeNull();

    await setMemberLoginParty(ctx.db, targetUserId, null, ctx.actor);
    const unlinked = await listMemberLogins(ctx.db);
    expect(
      unlinked.users.find((authUser) => authUser.id === targetUserId)
        ?.ledgerParty,
    ).toBeNull();
  });

  it("does not let two logins claim the same member party", async () => {
    const otherUserId = testUserId("other-member-login-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other Household Member",
      email: "other-member@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const party = await createLedgerParty(
      ctx.db,
      { name: "Claimed Member", kind: "member", notes: null },
      ctx.actor,
    );
    await setMemberLoginParty(
      ctx.db,
      ctx.actor.userId,
      party.output.id,
      ctx.actor,
    );

    await expect(
      setMemberLoginParty(ctx.db, otherUserId, party.output.id, ctx.actor),
    ).rejects.toThrow("already linked to another login");
  });
});
