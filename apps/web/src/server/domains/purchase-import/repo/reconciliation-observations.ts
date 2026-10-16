import { entityIdSchema, parseEntityId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import {
  acceptedSourceOrder,
  importExtractionOutcome,
  importSourceKind,
  sourceOrderObservationBindings,
  type ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {
  entityIdentity,
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  user,
  vendor,
  purchase,
  sourceOrderObservation,
} from "~/server/db/schema";
import {
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "~/server/domains/purchase-import/repo/source-claim-family";
import { entityDetailJson } from "~/server/entity-kernel/repo/entity-source";

/** JSONB changes object-key order; review hashes must describe values, not serialization order. */
export function reconciliationFingerprint(value: unknown): Promise<string> {
  const objectSchema = z.record(z.string(), z.json());
  const canonical = (input: z.infer<typeof entityDetailJson>): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    const object = objectSchema.safeParse(input);
    if (!object.success) return JSON.stringify(input);
    return `{${Object.keys(object.data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object.data[key]!)}`)
      .join(",")}}`;
  };
  return sha256Hex(canonical(entityDetailJson.parse(value)));
}

export async function recordSourceOrderObservation(
  tx: Pick<DrizzleTransaction, "insert" | "select">,
  identity: Pick<
    typeof sourceOrderObservation.$inferInsert,
    "sourceClaimId" | "orderKey" | "purchaseId"
  >,
  input: Pick<
    ImportWriterInput,
    | "vendorId"
    | "source"
    | "extraction"
    | "primaryDocumentImageId"
    | "screenshotImageId"
    | "productResolutions"
  > & { runId: typeof sourceOrderObservation.$inferSelect.runId },
  bindings = sourceOrderObservationBindings.parse(
    (input.extraction.candidate?.lines ?? []).map((_, lineIndex) => {
      const resolution = input.productResolutions?.find(
        (row) => row.lineIndex === lineIndex,
      );
      return {
        lineIndex,
        productId:
          resolution?.kind === "existing" ? resolution.productId : null,
      };
    }),
  ),
) {
  const extraction = importExtractionOutcome.parse(input.extraction);
  const productBindings = sourceOrderObservationBindings.parse(bindings);
  const contentFingerprint = await reconciliationFingerprint({
    checksum: input.source.checksum,
    extraction,
    productBindings,
    primaryDocumentImageId: input.primaryDocumentImageId,
    screenshotImageId: input.screenshotImageId,
  });
  const values = {
    ...identity,
    vendorId: parseEntityId("vendor", input.vendorId),
    runId: input.runId,
    checksum: input.source.checksum,
    extraction,
    productBindings,
    primaryDocumentImageId: input.primaryDocumentImageId,
    screenshotImageId: input.screenshotImageId,
    contentFingerprint,
  };
  const [created] = await tx
    .insert(sourceOrderObservation)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await tx
    .select()
    .from(sourceOrderObservation)
    .where(
      and(
        eq(sourceOrderObservation.sourceClaimId, identity.sourceClaimId),
        eq(sourceOrderObservation.orderKey, identity.orderKey),
        eq(sourceOrderObservation.checksum, input.source.checksum),
        eq(sourceOrderObservation.contentFingerprint, contentFingerprint),
      ),
    );
  if (
    !existing ||
    !(await sourceObservationIdentityMatches(
      tx,
      "purchase",
      existing.purchaseId,
      identity.purchaseId,
    )) ||
    !(await sourceObservationIdentityMatches(
      tx,
      "vendor",
      existing.vendorId,
      values.vendorId,
    ))
  )
    throw new Error(
      "Source observation identity changed; review its ownership.",
    );
  return existing;
}

const observationIdentity = alias(
  entityIdentity,
  "source_observation_identity",
);

/** Existing Entity redirects are compressed at merge; historical UUIDs never move. */
export function sourceObservationIdentitySql(
  kind: "purchase" | "vendor" | "product",
  original: SQLWrapper,
  current: SQLWrapper,
) {
  return sql<boolean>`(${original} = ${current} OR EXISTS (
    SELECT 1 FROM ${entityIdentity} AS "source_observation_identity"
    WHERE ${observationIdentity.id} = ${original}
      AND ${observationIdentity.kind} = ${kind}
      AND ${observationIdentity.mergedIntoId} = ${current}
  ))`;
}

export async function sourceObservationIdentityMatches(
  tx: Pick<DrizzleTransaction, "select">,
  kind: "purchase" | "vendor" | "product",
  original: string,
  current: string,
) {
  if (original === current) return true;
  const [identity] = await tx
    .select({ id: entityIdentity.id })
    .from(entityIdentity)
    .where(
      and(
        eq(entityIdentity.id, original),
        eq(entityIdentity.kind, kind),
        eq(entityIdentity.mergedIntoId, current),
      ),
    );
  return Boolean(identity);
}

/** Reuse a vendor's historical order key only through its durable merge identity. */
export async function mergedVendorSourceOrder(
  tx: Pick<DrizzleTransaction, "select">,
  claimIds: readonly string[],
  orderKey: string,
  vendorId: typeof purchase.$inferSelect.vendorId,
) {
  const originalVendor = alias(entityIdentity, "source_order_original_vendor");
  const suffix = orderKey.slice(orderKey.indexOf("/"));
  const rows = await tx
    .select({ association: importSourceOrder })
    .from(importSourceOrder)
    .innerJoin(
      purchase,
      and(
        eq(purchase.id, importSourceOrder.purchaseId),
        eq(purchase.vendorId, vendorId),
        notDeleted(purchase),
      ),
    )
    .innerJoin(
      originalVendor,
      and(
        sql`${originalVendor.id}::text = split_part(${importSourceOrder.orderKey}, '/', 1)`,
        eq(originalVendor.kind, "vendor"),
        or(
          eq(originalVendor.id, vendorId),
          eq(originalVendor.mergedIntoId, vendorId),
        ),
      ),
    )
    .where(
      and(
        inArray(importSourceOrder.sourceClaimId, [...claimIds]),
        sql`substring(${importSourceOrder.orderKey} from position('/' in ${importSourceOrder.orderKey})) = ${suffix}`,
      ),
    )
    .orderBy(importSourceOrder.id)
    .limit(2)
    .for("update", { of: [importSourceOrder, purchase] });
  if (rows.length > 1)
    throw new Error(
      "Ambiguous merged Vendor source order associations require explicit review.",
    );
  return rows[0]?.association ?? null;
}

/** Promote stored evidence only; absent historical decisions and media remain unknown. */
export async function promoteHistoricalAcceptedObservation(
  tx: Pick<DrizzleTransaction, "select" | "insert" | "update">,
  sourceOrderId: string,
) {
  const [initial] = await tx
    .select()
    .from(importSourceOrder)
    .where(eq(importSourceOrder.id, sourceOrderId));
  if (!initial || initial.acceptedObservationId)
    return initial?.acceptedObservationId ?? null;
  const preliminary = acceptedSourceOrder.safeParse(initial.originalOrder);
  if (!preliminary.success || preliminary.data.checksum !== initial.checksum)
    return null;
  const [owned] = await tx
    .select({ claim: importSourceClaim })
    .from(importSourceClaim)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
        eq(ledgerParty.kind, ledgerPartyKind.enum.member),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(eq(importSourceClaim.id, initial.sourceClaimId));
  if (!owned) return null;
  const claim = owned.claim;
  const family = await readImportSourceClaimFamily(
    tx,
    {
      ledgerPartyId: claim.ledgerPartyId,
      kind: claim.kind,
      externalKey: claim.externalKey,
    },
    { lock: "update" },
  );
  if (!family) return null;
  const retained = await readSourceFamilyOrder(
    tx,
    family,
    initial.orderKey,
    "update",
  );
  if (retained?.association.id !== initial.id)
    throw new Error("Historical accepted source family identity changed.");
  const order = retained.association;
  if (order.acceptedObservationId) return order.acceptedObservationId;
  const parsed = acceptedSourceOrder.safeParse(order.originalOrder);
  if (!parsed.success || parsed.data.checksum !== order.checksum) return null;
  const [ownedTarget] = await tx
    .select({ target: purchase })
    .from(purchase)
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .where(and(eq(purchase.id, order.purchaseId), notDeleted(purchase)))
    .for("update", { of: purchase });
  if (!ownedTarget) return null;
  const target = ownedTarget.target;
  const historicalVendor = entityIdSchema("vendor").safeParse(
    order.orderKey.split("/")[0],
  );
  if (
    !historicalVendor.success ||
    !(await sourceObservationIdentityMatches(
      tx,
      "vendor",
      historicalVendor.data,
      target.vendorId,
    ))
  )
    return null;
  const observation = await recordSourceOrderObservation(
    tx,
    {
      sourceClaimId: order.sourceClaimId,
      orderKey: order.orderKey,
      purchaseId: order.purchaseId,
    },
    {
      vendorId: historicalVendor.data,
      runId: null,
      source: {
        kind: importSourceKind.parse(claim.kind),
        externalKey: claim.externalKey,
        checksum: order.checksum,
      },
      extraction: parsed.data.extraction,
      primaryDocumentImageId: null,
      screenshotImageId: null,
    },
  );
  await tx
    .update(importSourceOrder)
    .set({ acceptedObservationId: observation.id })
    .where(eq(importSourceOrder.id, order.id));
  return observation.id;
}

/** A historical accepted extraction whose bytes were overwritten remains unknown. */
export async function acceptedSourceExtraction(
  tx: Pick<DrizzleTransaction, "select">,
  order: typeof importSourceOrder.$inferSelect,
) {
  if (order.acceptedObservationId) {
    const [observation] = await tx
      .select()
      .from(sourceOrderObservation)
      .where(eq(sourceOrderObservation.id, order.acceptedObservationId));
    if (
      !observation ||
      observation.sourceClaimId !== order.sourceClaimId ||
      observation.orderKey !== order.orderKey ||
      !(await sourceObservationIdentityMatches(
        tx,
        "purchase",
        observation.purchaseId,
        order.purchaseId,
      )) ||
      observation.checksum !== order.checksum
    )
      throw new Error(
        "Accepted source observation no longer matches its association.",
      );
    const [target] = await tx
      .select({ vendorId: purchase.vendorId })
      .from(purchase)
      .where(and(eq(purchase.id, order.purchaseId), notDeleted(purchase)));
    if (
      !target ||
      !(await sourceObservationIdentityMatches(
        tx,
        "vendor",
        observation.vendorId,
        target.vendorId,
      ))
    )
      throw new Error(
        "Accepted source observation vendor no longer matches its association.",
      );
    return acceptedSourceOrder.parse(observation);
  }
  return order.originalOrder?.checksum === order.checksum
    ? acceptedSourceOrder.parse(order.originalOrder)
    : null;
}
