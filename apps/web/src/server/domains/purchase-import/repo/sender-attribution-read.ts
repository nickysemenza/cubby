import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { SenderAttribution } from "@cubby/schemas/mail-coverage";
import {
  vendorEmailSenderList,
  vendorEmailSenderPolicies,
} from "@cubby/schemas/vendor-import-fields";
import { and, eq, inArray, sql } from "drizzle-orm";

import { broadcastSender, senderAddress } from "~/lib/vendor/domains";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import type { RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { email, purchase, vendor } from "~/server/db/retained-tables";
import { emailPurchaseEvidenceSql } from "~/server/domains/email/repo/email-purchase-links";
type Db = Database | DrizzleTransaction;
const normalizedSender = sql<
  string | null
>`lower(trim(coalesce(substring(${email.sender} from '<([^>]+)>'), ${email.sender})))`;

/** Whole accepted-source population establishes conflicts; only the evidence preview is capped. */
export async function readSenderAttributions(
  db: Db,
  addresses?: readonly string[],
): Promise<SenderAttribution[]> {
  const validAddress = (value: string | null) => {
    const parsed = vendorEmailSenderList.element.safeParse(
      senderAddress(value),
    );
    return parsed.success ? parsed.data : null;
  };
  const requested = addresses
    ?.map(validAddress)
    .filter((value): value is string => value !== null);
  const client = unwrapDb(db);
  const [vendors, evidence] = await Promise.all([
    client
      .select({
        id: vendor.id,
        code: vendor.shortcode,
        name: vendor.name,
        senders: vendor.orderEmailSenders,
        policies: vendor.orderEmailSenderPolicies,
      })
      .from(vendor)
      .where(notDeleted(vendor)),
    client
      .selectDistinct({
        sender: normalizedSender,
        emailId: email.shortcode,
        purchaseId: purchase.shortcode,
        vendorId: vendor.shortcode,
        vendorName: vendor.name,
      })
      .from(email)
      .innerJoin(
        sql`LATERAL (${emailPurchaseEvidenceSql()}) proof`,
        sql`proof.kind = ${emailLinkEvidenceKind.enum.accepted} AND NOT proof.changed`,
      )
      .innerJoin(
        purchase,
        and(sql`${purchase.id} = proof."purchaseId"`, notDeleted(purchase)),
      )
      .innerJoin(
        vendor,
        and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
      )
      .where(
        and(
          notDeleted(email),
          requested ? inArray(normalizedSender, requested) : undefined,
        ),
      ),
  ]);
  const policies = vendors.map((row) => ({
    ...row,
    policies: vendorEmailSenderPolicies.parse(row.policies),
  }));
  const ownersBySender = new Map<string, typeof policies>();
  const evidenceBySender = new Map<string, typeof evidence>();
  const excludedSenders = new Set<string>();
  for (const row of policies) {
    for (const [address, policy] of Object.entries(row.policies))
      if (policy === "excluded") excludedSenders.add(address);
    for (const address of new Set(
      row.senders
        .map(validAddress)
        .filter((value): value is string => value !== null),
    )) {
      const owners = ownersBySender.get(address);
      if (owners) owners.push(row);
      else ownersBySender.set(address, [row]);
    }
  }
  for (const row of evidence) {
    const address = validAddress(row.sender);
    if (!address) continue;
    const group = evidenceBySender.get(address);
    if (group) group.push(row);
    else evidenceBySender.set(address, [row]);
  }
  const senders = requested ?? [
    ...new Set([
      ...vendors.flatMap((row) =>
        row.senders
          .map(validAddress)
          .filter((value): value is string => value !== null),
      ),
      ...evidenceBySender.keys(),
    ]),
  ];
  return senders.map((sender) => {
    const owners = ownersBySender.get(sender) ?? [];
    const sources = evidenceBySender.get(sender) ?? [];
    const sellerIds = new Set([
      ...owners.map((row) => row.code),
      ...sources.map((row) => row.vendorId),
    ]);
    const excluded = excludedSenders.has(sender);
    const owner = owners.length === 1 ? owners[0] : undefined;
    const state = broadcastSender(sender)
      ? "shared"
      : owners.length > 0 &&
          (sellerIds.size > 1 ||
            (owner?.policies[sender] === "learned" && sources.length === 0))
        ? "disputed"
        : owners.length === 0 && sellerIds.size > 1
          ? "shared"
          : owner
            ? "verified"
            : excluded
              ? "excluded"
              : "unmapped";
    return {
      sender,
      state,
      origin: owner
        ? owner.policies[sender] === "learned"
          ? "learned"
          : "member"
        : null,
      vendorId:
        state === "verified" && owner
          ? parseShortcodeFor("vendor", owner.code)
          : null,
      vendors: owners.map((row) => ({
        id: parseShortcodeFor("vendor", row.code),
        name: row.name,
      })),
      evidenceCount: sources.length,
      evidence: sources
        .slice(0, 20)
        .map(({ emailId, purchaseId, vendorId, vendorName }) => ({
          emailId: parseShortcodeFor("email", emailId),
          purchaseId: parseShortcodeFor("purchase", purchaseId),
          vendorId: parseShortcodeFor("vendor", vendorId),
          vendorName,
        })),
    };
  });
}
