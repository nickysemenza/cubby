import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { importSourceClaim, importSourceOrder } from "~/server/db/schema";

type Reader = Pick<DrizzleClient, "select">;
type FamilyIdentity = Pick<
  typeof importSourceClaim.$inferSelect,
  "ledgerPartyId" | "kind" | "externalKey"
>;
type Claim = typeof importSourceClaim.$inferSelect;
type Family = { root: Claim; members: Claim[] };
type ReadOptions = { lock?: "update" | "share"; writable?: boolean };

function assertWritableIdentity(input: FamilyIdentity) {
  if (
    (input.kind === "mail_message" || input.kind === "mail_attachment") &&
    /^gmail:[^:]+:order:/u.test(input.externalKey)
  )
    throw new Error(
      "Historical Gmail per-order keys are read-only; verify the canonical original source identity.",
    );
}

export async function readImportSourceClaimFamily(
  db: Reader,
  input: FamilyIdentity,
  options: ReadOptions = {},
): Promise<Family | null> {
  if (options.writable) assertWritableIdentity(input);
  const [selected] = await db
    .select()
    .from(importSourceClaim)
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, input.ledgerPartyId),
        eq(importSourceClaim.kind, input.kind),
        eq(importSourceClaim.externalKey, input.externalKey),
      ),
    )
    .limit(1);
  if (!selected) return null;
  if (options.writable && selected.canonicalClaimId !== null)
    throw new Error(
      "Historical source aliases are read-only; use the canonical source identity.",
    );
  const rootId = selected.canonicalClaimId ?? selected.id;
  const rootQuery = db
    .select()
    .from(importSourceClaim)
    .where(eq(importSourceClaim.id, rootId));
  const [root] = await (options.lock ? rootQuery.for(options.lock) : rootQuery);
  if (
    !root ||
    root.canonicalClaimId !== null ||
    root.ledgerPartyId !== input.ledgerPartyId ||
    root.kind !== input.kind
  )
    throw new Error("Source claim family has an invalid canonical owner.");
  const membersQuery = db
    .select()
    .from(importSourceClaim)
    .where(
      or(
        eq(importSourceClaim.id, root.id),
        eq(importSourceClaim.canonicalClaimId, root.id),
      ),
    )
    .orderBy(asc(importSourceClaim.id));
  const members = await (options.lock
    ? membersQuery.for(options.lock)
    : membersQuery);
  if (
    !members.some((member) => member.id === selected.id) ||
    members.some(
      (member) =>
        member.ledgerPartyId !== root.ledgerPartyId ||
        member.kind !== root.kind,
    )
  )
    throw new Error(
      "Source claim family crosses member ownership or source kind.",
    );
  return { root, members };
}

/** Current raw-source bytes belong to the root; historical aliases retain their own history. */
export async function lockImportSourceClaimFamily(
  tx: Pick<DrizzleTransaction, "select" | "insert" | "update">,
  input: Pick<
    typeof importSourceClaim.$inferInsert,
    | "ledgerPartyId"
    | "kind"
    | "externalKey"
    | "checksum"
    | "vendorAccountId"
    | "firstRunId"
    | "lastRunId"
  >,
) {
  let family = await readImportSourceClaimFamily(tx, input, {
    lock: "update",
    writable: true,
  });
  if (!family) {
    await tx
      .insert(importSourceClaim)
      .values(input)
      .onConflictDoNothing({
        target: [
          importSourceClaim.ledgerPartyId,
          importSourceClaim.kind,
          importSourceClaim.externalKey,
        ],
      });
    family = await readImportSourceClaimFamily(tx, input, {
      lock: "update",
      writable: true,
    });
  }
  if (!family)
    throw new Error("Canonical import source claim was not persisted.");
  if (family.root.checksum !== input.checksum) {
    await tx
      .update(importSourceClaim)
      .set({ checksum: input.checksum, updatedAt: new Date() })
      .where(eq(importSourceClaim.id, family.root.id));
    family.root.checksum = input.checksum;
  }
  return family;
}

/** Resolve one order across the family before replay or mutation; duplicates never choose an owner. */
export async function readSourceFamilyOrder(
  db: Reader,
  family: Family,
  orderKey: typeof importSourceOrder.$inferSelect.orderKey,
  lock?: ReadOptions["lock"],
) {
  const query = db
    .select()
    .from(importSourceOrder)
    .where(
      and(
        inArray(
          importSourceOrder.sourceClaimId,
          family.members.map((member) => member.id),
        ),
        eq(importSourceOrder.orderKey, orderKey),
      ),
    )
    .orderBy(asc(importSourceOrder.id))
    .limit(2);
  const orders = await (lock ? query.for(lock) : query);
  if (orders.length > 1)
    throw new Error(
      "Duplicate source family order associations require review.",
    );
  const association = orders[0];
  if (!association) return null;
  const claim = family.members.find(
    (member) => member.id === association.sourceClaimId,
  );
  if (!claim) throw new Error("Source family order owner is unavailable.");
  return { claim, association };
}

export async function resolveImportSourceOrder(
  db: Reader,
  input: FamilyIdentity & {
    orderKey: typeof importSourceOrder.$inferSelect.orderKey;
  },
  options: ReadOptions = {},
) {
  const family = await readImportSourceClaimFamily(db, input, options);
  return family
    ? readSourceFamilyOrder(db, family, input.orderKey, options.lock)
    : null;
}

/** Research reads canonical and historical keys without making aliases writable identities. */
export async function loadImportSourceFamilyOrders(
  db: Reader,
  input: Pick<FamilyIdentity, "ledgerPartyId"> & {
    externalKeys: readonly string[];
  },
) {
  if (!input.externalKeys.length) return [];
  const selected = await db
    .select()
    .from(importSourceClaim)
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, input.ledgerPartyId),
        inArray(importSourceClaim.externalKey, [
          ...new Set(input.externalKeys),
        ]),
      ),
    )
    .orderBy(asc(importSourceClaim.id))
    .limit(101);
  if (selected.length > 100)
    throw new Error("Source lineage needs a narrower research proposal.");
  const seen = new Set<Claim["id"]>();
  const rows: {
    claim: Claim;
    association: typeof importSourceOrder.$inferSelect;
  }[] = [];
  for (const claim of selected) {
    const family = await readImportSourceClaimFamily(db, claim, {});
    if (!family || seen.has(family.root.id)) continue;
    seen.add(family.root.id);
    const orders = await db
      .select()
      .from(importSourceOrder)
      .where(
        inArray(
          importSourceOrder.sourceClaimId,
          family.members.map((member) => member.id),
        ),
      )
      .orderBy(asc(importSourceOrder.id))
      .limit(101);
    const keys = new Set<string>();
    for (const association of orders) {
      if (keys.has(association.orderKey))
        throw new Error(
          "Duplicate source family order associations require review.",
        );
      keys.add(association.orderKey);
      const owner = family.members.find(
        (member) => member.id === association.sourceClaimId,
      );
      if (!owner) throw new Error("Source family order owner is unavailable.");
      rows.push({ claim: owner, association });
    }
    if (rows.length > 100)
      throw new Error("Source lineage needs a narrower research proposal.");
  }
  return rows;
}
