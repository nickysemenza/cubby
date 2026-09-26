import type { ActorContext } from "@cubby/schemas/context";
import type {
  LedgerPartyId,
  LedgerPartyShortcode,
  UserId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, asc, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { user } from "~/server/db/auth.schema";
import { ledgerParty } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

export type CurrentParty = {
  id: LedgerPartyId;
  shortcode: LedgerPartyShortcode;
  name: string;
};

/** The live `member` ledger party the acting login is linked to, if any. */
export async function currentMemberLedgerParty(
  db: Database | DrizzleTransaction,
  actor: { userId: UserId },
): Promise<CurrentParty | null> {
  const [party] = await unwrapDb(db)
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
    })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  return party
    ? { ...party, shortcode: parseShortcodeFor("ledgerParty", party.shortcode) }
    : null;
}

export type MemberLoginUser = {
  id: string;
  name: string;
  email: string;
  ledgerParty: {
    shortcode: LedgerPartyShortcode;
    name: string;
  } | null;
};

export type MemberLoginParty = {
  shortcode: LedgerPartyShortcode;
  name: string;
  userId: string | null;
};

/** The small trusted-household roster used to make auth ownership visible. */
export async function listMemberLogins(db: Database): Promise<{
  users: MemberLoginUser[];
  parties: MemberLoginParty[];
}> {
  const [users, parties] = await Promise.all([
    getDb(db)
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .orderBy(asc(user.email)),
    getDb(db)
      .select({
        shortcode: ledgerParty.shortcode,
        name: ledgerParty.name,
        userId: ledgerParty.userId,
      })
      .from(ledgerParty)
      .where(and(eq(ledgerParty.kind, "member"), notDeleted(ledgerParty)))
      .orderBy(asc(ledgerParty.name)),
  ]);
  const partyByUser = new Map<string, (typeof parties)[number]>(
    parties.flatMap((party) =>
      party.userId ? [[party.userId, party] as const] : [],
    ),
  );
  return {
    users: users.map((authUser) => {
      const party = partyByUser.get(authUser.id);
      return {
        ...authUser,
        ledgerParty: party
          ? {
              shortcode: parseShortcodeFor("ledgerParty", party.shortcode),
              name: party.name,
            }
          : null,
      };
    }),
    parties: parties.map((party) => ({
      ...party,
      shortcode: parseShortcodeFor("ledgerParty", party.shortcode),
    })),
  };
}

/** Atomically maintains the one-login-to-one-member ownership relation. */
export async function setMemberLoginParty(
  db: Database,
  targetUserId: UserId,
  shortcode: LedgerPartyShortcode | null,
  actor: ActorContext,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const [authUser] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, targetUserId))
      .limit(1);
    if (!authUser) {
      throw createAppError("CONSTRAINT_VIOLATION", "Login not found.");
    }

    const current = await tx
      .select({ id: ledgerParty.id, userId: ledgerParty.userId })
      .from(ledgerParty)
      .where(and(eq(ledgerParty.userId, targetUserId), notDeleted(ledgerParty)))
      .for("update");

    let target: {
      id: (typeof ledgerParty.$inferSelect)["id"];
      userId: UserId | null;
    } | null = null;
    if (shortcode) {
      const targetId = await resolveOrThrow(tx, "ledgerParty", shortcode);
      const [row] = await tx
        .select({ id: ledgerParty.id, userId: ledgerParty.userId })
        .from(ledgerParty)
        .where(
          and(
            eq(ledgerParty.id, targetId),
            eq(ledgerParty.kind, "member"),
            notDeleted(ledgerParty),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Only member ledger parties can be linked to a login.",
        );
      }
      if (row.userId && row.userId !== targetUserId) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "That ledger party is already linked to another login.",
        );
      }
      target = row;
    }

    const now = new Date();
    for (const party of current) {
      if (party.id === target?.id) continue;
      await tx
        .update(ledgerParty)
        .set({ userId: null, updatedAt: now })
        .where(
          and(
            eq(ledgerParty.id, party.id),
            eq(ledgerParty.userId, targetUserId),
          ),
        );
      await logAuditEntry(tx, actor, {
        entityType: "ledgerParty",
        entityId: party.id,
        action: "update",
        changes: { userId: { from: targetUserId, to: null } },
      });
    }

    if (target && target.userId !== targetUserId) {
      await tx
        .update(ledgerParty)
        .set({ userId: targetUserId, updatedAt: now })
        .where(eq(ledgerParty.id, target.id));
      await logAuditEntry(tx, actor, {
        entityType: "ledgerParty",
        entityId: target.id,
        action: "update",
        changes: { userId: { from: target.userId, to: targetUserId } },
      });
    }
  });
}
