import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { LedgerPartyId, ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityAttachment,
  entityExternalId,
  image,
  product,
} from "~/server/db/schema";
import { notDeleted, withTransactionOn } from "~/server/repo/database-helpers";

import {
  loadCurrentFactEvidence,
  type ResearchCanonicalProjection,
} from "./fact-verification";

const productResearchFields = [
  "manufacturer",
  "model",
  "categoryId",
  "externalIds",
  "images",
] as const;

/** Retired rationale remains visible provenance but cannot satisfy current proof coverage. */
export async function loadProductResearchCoverage(
  db: Database | DrizzleTransaction,
  input: { productId: ProductId; ledgerPartyId: LedgerPartyId },
) {
  const identity = await withTransactionOn(db, async (tx) => {
    const [row] = await tx
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(and(eq(product.id, input.productId), notDeleted(product)))
      .limit(1);
    if (!row) throw new Error("Research Product identity is unavailable.");
    return row;
  });
  const coverage = await Promise.all(
    productResearchFields.map(async (fieldPath) => ({
      fieldPath,
      verified: (
        await loadCurrentFactEvidence(
          db,
          {
            entityKind: "product",
            entityId: identity.shortcode,
            fieldPath,
            ledgerPartyId: input.ledgerPartyId,
          },
          readResearchCanonicalProjection,
        )
      ).some(
        (proof) => proof.support !== null && proof.supportRetiredAt === null,
      ),
    })),
  );
  return {
    complete: coverage.every((field) => field.verified),
    verifiedFields: coverage
      .filter((field) => field.verified)
      .map((field) => field.fieldPath),
    missingFields: coverage
      .filter((field) => !field.verified)
      .map((field) => field.fieldPath),
  };
}

export const researchMemberPath = (
  root: "externalIds" | "images",
  id: string,
) => `${root}.i${id.replaceAll("-", "")}`;

/** Relation roots enumerate owned live members; explicit paths can never read a foreign operand. */
export const readResearchCanonicalProjection: ResearchCanonicalProjection =
  async (tx, target) => {
    const values: NonNullable<
      Awaited<ReturnType<ResearchCanonicalProjection>>
    > = {};
    const requested = (root: string, path: string) =>
      target.fieldPaths.includes(root) || target.fieldPaths.includes(path);
    const declared = (root: string) =>
      entityFieldModels[target.entityKind].fields.some(
        (field) => field.key === root || field.readKey === root,
      );
    if (
      declared("externalIds") &&
      target.fieldPaths.some(
        (path) => path === "externalIds" || path.startsWith("externalIds."),
      )
    ) {
      const rows = await tx
        .select()
        .from(entityExternalId)
        .where(
          and(
            eq(entityExternalId.entityKind, target.entityKind),
            eq(entityExternalId.entityId, target.entityId),
            notDeleted(entityExternalId),
          ),
        );
      for (const row of rows) {
        const path = researchMemberPath("externalIds", row.id);
        if (requested("externalIds", path))
          values[path] = {
            source: row.source,
            kind: row.kind,
            externalId: row.externalId,
          };
      }
    }
    if (
      declared("images") &&
      target.fieldPaths.some(
        (path) => path === "images" || path.startsWith("images."),
      )
    ) {
      const rows = await tx
        .select({
          attachmentId: entityAttachment.id,
          shortcode: image.shortcode,
          sourceAssetUrl: image.sourceAssetUrl,
          sha256: image.sha256,
        })
        .from(entityAttachment)
        .innerJoin(
          image,
          and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
        )
        .where(
          and(
            eq(entityAttachment.entityKind, target.entityKind),
            eq(entityAttachment.entityId, target.entityId),
            notDeleted(entityAttachment),
          ),
        );
      for (const row of rows) {
        const path = researchMemberPath("images", row.attachmentId);
        if (requested("images", path) && row.sha256)
          values[path] = {
            imageId: row.shortcode,
            sourceAssetUrl: row.sourceAssetUrl,
            contentHash: row.sha256,
          };
      }
    }
    return values;
  };
