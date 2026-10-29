import type { ActorContext } from "@cubby/schemas/context";
import type { VendorId } from "@cubby/schemas/identifiers";
import type { SenderAttribution } from "@cubby/schemas/mail-coverage";
import type { setVendorSenderInput } from "@cubby/schemas/vendor";
import { vendorEmailSenderPolicies } from "@cubby/schemas/vendor-import-fields";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { broadcastSender, senderAddress } from "~/lib/vendor/domains";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, isTransaction } from "~/server/db/helpers";
import { databaseForTransaction } from "~/server/db/helpers";
import { vendor } from "~/server/db/retained-tables";
import { readSenderAttributions } from "~/server/domains/purchase-import/repo/sender-attribution-read";
import { lockCorrectionKey } from "~/server/generic/assessment/repo/correction-lock";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
type Db = Database | DrizzleTransaction;

/** Acquire in address order before Vendor locks; late receipt learning must never wait on a merger. */
export async function lockSenderAttributionAddress(
  db: Db,
  address: string,
  tryOnly = false,
): Promise<boolean> {
  const key = `vendor-sender:${address}`;
  const client = unwrapDb(db);
  if (tryOnly) {
    const result = z
      .object({ rows: z.array(z.object({ acquired: z.boolean() })) })
      .parse(
        await client.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`,
        ),
      ).rows[0];
    if (!result?.acquired) return false;
  } else
    await client.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  await lockCorrectionKey(
    isTransaction(db) ? databaseForTransaction(db) : db,
    key,
  );
  return true;
}

/** Accepted receipt evidence can add an address; a member's exclusion is never automatically reversed. */
export async function learnAcceptedSender(
  db: Db,
  sender: string | null,
  vendorId: VendorId,
  actor: ActorContext,
): Promise<boolean> {
  const address = senderAddress(sender);
  if (!address || broadcastSender(address)) return false;
  const [proof] = await readSenderAttributions(db, [address]);
  return proof ? learnFromProof(db, proof, vendorId, actor) : false;
}

async function learnFromProof(
  db: Db,
  proof: SenderAttribution,
  vendorId: VendorId,
  actor: ActorContext,
): Promise<boolean> {
  const address = proof.sender;
  if (broadcastSender(address)) return false;
  if (
    !proof ||
    proof.state !== "unmapped" ||
    proof.evidenceCount === 0 ||
    new Set(proof.evidence.map((item) => item.vendorId)).size !== 1
  )
    return false;
  const client = unwrapDb(db);
  if (!(await lockSenderAttributionAddress(db, address, true))) return false;
  const [row] = await client
    .select()
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), notDeleted(vendor)))
    .for("no key update");
  if (
    !row ||
    proof.evidence[0]?.vendorId !== row.shortcode ||
    row.orderEmailSenders.length >= 50
  )
    return false;
  const policies = vendorEmailSenderPolicies.parse(
    row.orderEmailSenderPolicies,
  );
  if (
    policies[address] === "excluded" ||
    row.orderEmailSenders.some((value) => senderAddress(value) === address)
  )
    return false;
  // Recheck after acquiring the row lock so a concurrent member decision wins.
  const [current] = await readSenderAttributions(db, [address]);
  if (!current || current.state !== "unmapped") return false;
  const senders = [...new Set([...row.orderEmailSenders, address])];
  await client
    .update(vendor)
    .set({
      orderEmailSenders: senders,
      orderEmailSenderPolicies: { ...policies, [address]: "learned" },
    })
    .where(eq(vendor.id, vendorId));
  await logAuditEntry(db, actor, {
    entityKind: "vendor",
    entityId: vendorId,
    action: "update",
    changes: {
      orderEmailSenders: { from: row.orderEmailSenders, to: senders },
    },
  });
  await recordChange(db, { kind: "source", categories: ["vendor", "email"] });
  return true;
}

/** Optimistic ownership check prevents a stale inspector from silently moving a newer decision. */
export async function setSenderAttribution(
  db: Db,
  input: z.infer<typeof setVendorSenderInput>,
  actor: ActorContext,
): Promise<void> {
  if (broadcastSender(input.sender) && input.vendorId)
    throw new Error(
      "This provider-wide address serves multiple sellers; use receipt-level attribution.",
    );
  const client = unwrapDb(db);
  await lockSenderAttributionAddress(db, input.sender);
  const rows = await client
    .select()
    .from(vendor)
    .where(
      and(
        notDeleted(vendor),
        or(
          sql`EXISTS (SELECT 1 FROM unnest(${vendor.orderEmailSenders}) AS known(address) WHERE lower(trim(known.address)) = ${input.sender})`,
          input.vendorId ? eq(vendor.shortcode, input.vendorId) : undefined,
        ),
      ),
    )
    .orderBy(vendor.id)
    .for("no key update");
  const owners = rows.filter((row) =>
    row.orderEmailSenders.some(
      (value) => senderAddress(value) === input.sender,
    ),
  );
  if (
    JSON.stringify(owners.map((row) => row.shortcode).sort()) !==
    JSON.stringify([...input.expectedVendorIds].sort())
  )
    throw new Error(
      "Sender attribution changed. Refresh coverage before saving.",
    );
  const target = input.vendorId
    ? rows.find((row) => row.shortcode === input.vendorId)
    : null;
  if (input.vendorId && !target) throw new Error("Vendor not found.");
  for (const row of rows.filter(
    (row) =>
      row.id === target?.id || owners.some((owner) => owner.id === row.id),
  )) {
    const policies = vendorEmailSenderPolicies.parse(
      row.orderEmailSenderPolicies,
    );
    const senders =
      row.id === target?.id
        ? [...new Set([...row.orderEmailSenders, input.sender])]
        : row.orderEmailSenders.filter(
            (address) => senderAddress(address) !== input.sender,
          );
    if (senders.length > 50)
      throw new Error("This Vendor already has fifty sender addresses.");
    policies[input.sender] = row.id === target?.id ? "confirmed" : "excluded";
    await client
      .update(vendor)
      .set({ orderEmailSenders: senders, orderEmailSenderPolicies: policies })
      .where(eq(vendor.id, row.id));
    await logAuditEntry(db, actor, {
      entityKind: "vendor",
      entityId: row.id,
      action: "update",
      changes: {
        orderEmailSenders: { from: row.orderEmailSenders, to: senders },
      },
    });
  }
  await recordChange(db, { kind: "source", categories: ["vendor", "email"] });
}

/** Bootstrap existing accepted receipts without a parallel mapping registry or source rewrite. */
export async function learnAcceptedSenders(
  db: Db,
  actor: ActorContext,
): Promise<number> {
  const proofs = await readSenderAttributions(db);
  const client = unwrapDb(db);
  const vendors = await client
    .select({
      id: vendor.id,
      code: vendor.shortcode,
      senders: vendor.orderEmailSenders,
    })
    .from(vendor)
    .where(notDeleted(vendor));
  const capacity = new Map(
    vendors.map((row) => [row.code, 50 - row.senders.length]),
  );
  const eligible = proofs
    .filter((row) => {
      const seller = row.evidence[0]?.vendorId;
      if (
        row.state !== "unmapped" ||
        !seller ||
        (capacity.get(seller) ?? 0) <= 0
      )
        return false;
      capacity.set(seller, (capacity.get(seller) ?? 0) - 1);
      return true;
    })
    .sort((a, b) => a.sender.localeCompare(b.sender))
    .slice(0, 50);
  for (const proof of eligible)
    await lockSenderAttributionAddress(db, proof.sender);
  let learned = 0;
  for (const proof of eligible) {
    const seller = vendors.find(
      (row) => row.code === proof.evidence[0]?.vendorId,
    );
    if (seller && (await learnFromProof(db, proof, seller.id, actor)))
      learned++;
  }
  return learned;
}
