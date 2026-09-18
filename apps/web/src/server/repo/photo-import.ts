import type { Entity } from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import {
  type CoverEntity,
  entityManifest,
  isGalleryEntity,
  type GalleryEntity,
  type LogoEntity,
} from "@cubby/schemas/entity-manifest";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type {
  PhotoImportCommitInput,
  PhotoImportReceipt,
} from "~/contracts/photo-import.contract";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  aiAnalysis,
  cookbook,
  image,
  photoImportReceipt,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  associatePendingImages,
  getDb,
  imageJoinBindings,
  nextImageSortOrder,
  notDeleted,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { compileTraversal } from "~/server/repo/relatedness/traversal";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

export interface ImportImageRow {
  id: string;
  shortcode: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  status: "PENDING" | "UPLOADED" | "FAILED";
  sha256: string | null;
  width: number | null;
  height: number | null;
  renderStatus: "unverified" | "verified" | "failed" | null;
  storageStatus:
    | "unverified"
    | "available"
    | "missing"
    | "metadata_mismatch"
    | null;
}

export async function findReusableImagesBySha256(
  db: Database,
  hashes: readonly string[],
): Promise<Map<string, { shortcode: string }>> {
  if (hashes.length === 0) return new Map();
  const rows = await getDb(db)
    .select({ shortcode: image.shortcode, sha256: image.sha256 })
    .from(image)
    .where(
      and(
        inArray(image.sha256, [...new Set(hashes)]),
        eq(image.status, "UPLOADED"),
        eq(image.renderStatus, "verified"),
        eq(image.storageStatus, "available"),
        notDeleted(image),
      ),
    )
    .orderBy(desc(image.createdAt), desc(image.id));
  const reusable = new Map<string, { shortcode: string }>();
  for (const row of rows) {
    if (row.sha256 && !reusable.has(row.sha256)) {
      reusable.set(row.sha256, { shortcode: row.shortcode });
    }
  }
  return reusable;
}

export async function getImportImageRows(
  db: Database,
  shortcodes: readonly string[],
): Promise<ImportImageRow[]> {
  if (shortcodes.length === 0) return [];
  return await getDb(db)
    .select({
      id: image.id,
      shortcode: image.shortcode,
      key: image.key,
      filename: image.filename,
      contentType: image.contentType,
      size: image.size,
      status: image.status,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
      renderStatus: image.renderStatus,
      storageStatus: image.storageStatus,
    })
    .from(image)
    .where(and(inArray(image.shortcode, [...shortcodes]), notDeleted(image)));
}

export async function finalizeImportImage(
  db: Database,
  row: ImportImageRow,
  integrity: {
    width: number | null;
    height: number | null;
    detectedContentType: string;
    sha256: string;
    renderStatus: "verified" | "failed";
    storageStatus: "available";
    verifiedAt: Date;
  },
): Promise<void> {
  if (row.status === "UPLOADED") return;
  const updated = await getDb(db)
    .update(image)
    .set({ ...integrity, status: "UPLOADED", updatedAt: new Date() })
    .where(
      and(eq(image.id, row.id), eq(image.status, "PENDING"), notDeleted(image)),
    )
    .returning({ id: image.id });
  if (updated.length !== 1) {
    throw new Error(`Staged image ${row.shortcode} is no longer pending`);
  }
}

export async function persistLocalImageAnalysis(
  db: Database,
  imageId: string,
  analysis: PhotoImportCommitInput["images"][number]["analysis"],
  analysisVersion: number,
  inputFingerprint: string,
): Promise<void> {
  await getDb(db)
    .insert(aiAnalysis)
    .values({
      entityType: "image",
      entityId: imageId,
      feature: "photo-local-analysis",
      model: "vision-local",
      promptVersion: `analysis-v${analysisVersion}`,
      inputFingerprint,
      result: analysis,
    })
    .onConflictDoUpdate({
      target: [
        aiAnalysis.entityType,
        aiAnalysis.entityId,
        aiAnalysis.feature,
        aiAnalysis.model,
        aiAnalysis.promptVersion,
        aiAnalysis.inputFingerprint,
      ],
      targetWhere: isNull(aiAnalysis.deletedAt),
      set: { result: analysis, updatedAt: new Date() },
    });
}

export async function withPhotoImportTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
}

export async function findPhotoImportReceipt(
  db: Database | DrizzleTransaction,
  idempotencyKey: string,
): Promise<{ requestHash: string; receipt: unknown } | null> {
  const [row] = await unwrapDb(db)
    .select({
      requestHash: photoImportReceipt.requestHash,
      receipt: photoImportReceipt.receipt,
    })
    .from(photoImportReceipt)
    .where(eq(photoImportReceipt.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

export async function insertPhotoImportReceipt(
  db: Database,
  idempotencyKey: string,
  requestHash: string,
  receipt: PhotoImportReceipt,
): Promise<boolean> {
  const inserted = await getDb(db)
    .insert(photoImportReceipt)
    .values({ idempotencyKey, requestHash, receipt })
    .onConflictDoNothing({ target: photoImportReceipt.idempotencyKey })
    .returning({ id: photoImportReceipt.id });
  return inserted.length === 1;
}

export interface PhotoImportRelationTraversal {
  readonly targetEntity: Entity;
  readonly steps: readonly RelationshipPathStep[];
}

/** Expand logical manifest relationship keys into every declared local SQL path. */
export const photoImportRelationTraversals = (
  sourceEntity: Entity,
  relationPath: readonly string[],
): readonly PhotoImportRelationTraversal[] => {
  let traversals: PhotoImportRelationTraversal[] = [
    { targetEntity: sourceEntity, steps: [] },
  ];
  for (const relationshipKey of relationPath) {
    const expanded: PhotoImportRelationTraversal[] = [];
    for (const traversal of traversals) {
      const relationship = entityManifest[
        traversal.targetEntity
      ].relationships.find((candidate) => candidate.key === relationshipKey);
      if (!relationship) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Manifest relationship ${relationshipKey} does not leave ${traversal.targetEntity}`,
        );
      }
      const provenances = [
        relationship.provenance,
        ...relationship.sources.map((source) => source.provenance),
      ];
      for (const provenance of provenances) {
        if (provenance.kind !== "local-path") continue;
        expanded.push({
          targetEntity: relationship.target,
          steps: [...traversal.steps, ...provenance.steps],
        });
      }
    }
    if (expanded.length === 0) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Manifest relationship ${relationshipKey} has no local path`,
      );
    }
    traversals = expanded;
  }
  return traversals;
};

export async function photoImportRelationExists(
  db: Database,
  sourceEntity: Entity,
  sourceCode: string,
  relationPath: readonly string[],
  targetEntity: Entity,
  targetCode: string,
): Promise<boolean> {
  const plans = photoImportRelationTraversals(
    sourceEntity,
    relationPath,
  ).filter((plan) => plan.targetEntity === targetEntity);
  if (plans.length === 0) return false;
  const selects = plans.map((plan, index) => {
    const traversal = compileTraversal(
      sourceEntity,
      plan.steps,
      `photo_import_${index}_`,
      { root: "s", leaf: "t" },
    );
    return sql`SELECT 1 FROM ${sql.raw(`"${traversal.rootTable}"`)} s
      ${traversal.joins}
      WHERE s."shortcode" = ${sourceCode}
        AND s."deletedAt" IS NULL
        AND t."shortcode" = ${targetCode}`;
  });
  const result = await getDb(db).execute(sql`
    SELECT EXISTS(${sql.join(selects, sql` UNION ALL `)}) AS "related"
  `);
  return z.object({ related: z.boolean() }).parse(result.rows[0]).related;
}

export async function attachImportedGalleryImages<E extends GalleryEntity>(
  db: Database,
  entity: E,
  destinationCode: string,
  imageCodes: readonly string[],
): Promise<void> {
  if (!isGalleryEntity(entity)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Manifest destination ${entity} does not own a gallery`,
    );
  }
  const destinationId = await resolveOrThrow(db, entity, destinationCode);
  const imageIds = await resolveAllOrThrow(db, "image", imageCodes);
  const client = getDb(db);
  type GalleryBinding = Parameters<typeof nextImageSortOrder>[1];
  // SAFETY: `entity` was narrowed by `isGalleryEntity`; the generated
  // `imageJoinBindings` exhaustively maps that same GalleryEntity roster.
  const binding = imageJoinBindings[entity] as GalleryBinding;
  const startSortOrder = await nextImageSortOrder(
    client,
    binding,
    destinationId,
  );
  await associatePendingImages(
    client,
    binding,
    destinationId,
    [...imageIds],
    startSortOrder,
  );
}

interface SingularImageOwnerBinding {
  occupied(db: Database, destinationCode: string): Promise<boolean>;
  attach(
    db: Database,
    destinationCode: string,
    imageCode: string,
    replaceConfirmed: boolean,
  ): Promise<void>;
}

const singularImageOwnerBindings = {
  cookbook: {
    occupied: async (db, destinationCode) => {
      const destinationId = await resolveOrThrow(
        db,
        "cookbook",
        destinationCode,
      );
      const [current] = await getDb(db)
        .select({ imageId: cookbook.coverImageId })
        .from(cookbook)
        .where(and(eq(cookbook.id, destinationId), notDeleted(cookbook)))
        .limit(1);
      return current?.imageId != null;
    },
    attach: async (db, destinationCode, imageCode, replaceConfirmed) => {
      const destinationId = await resolveOrThrow(
        db,
        "cookbook",
        destinationCode,
      );
      const imageId = await resolveOrThrow(db, "image", imageCode);
      const client = getDb(db);
      const [current] = await client
        .select({ imageId: cookbook.coverImageId })
        .from(cookbook)
        .where(and(eq(cookbook.id, destinationId), notDeleted(cookbook)))
        .limit(1);
      if (current?.imageId && !replaceConfirmed) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Replacing this cookbook cover requires explicit confirmation",
        );
      }
      await client
        .update(cookbook)
        .set({ coverImageId: imageId, updatedAt: new Date() })
        .where(and(eq(cookbook.id, destinationId), notDeleted(cookbook)));
    },
  },
  vendor: {
    occupied: async (db, destinationCode) => {
      const destinationId = await resolveOrThrow(db, "vendor", destinationCode);
      const [current] = await getDb(db)
        .select({ imageId: vendor.logoImageId })
        .from(vendor)
        .where(and(eq(vendor.id, destinationId), notDeleted(vendor)))
        .limit(1);
      return current?.imageId != null;
    },
    attach: async (db, destinationCode, imageCode, replaceConfirmed) => {
      const destinationId = await resolveOrThrow(db, "vendor", destinationCode);
      const imageId = await resolveOrThrow(db, "image", imageCode);
      const client = getDb(db);
      const [current] = await client
        .select({ imageId: vendor.logoImageId })
        .from(vendor)
        .where(and(eq(vendor.id, destinationId), notDeleted(vendor)))
        .limit(1);
      if (current?.imageId && !replaceConfirmed) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Replacing this vendor logo requires explicit confirmation",
        );
      }
      await client
        .update(vendor)
        .set({ logoImageId: imageId, updatedAt: new Date() })
        .where(and(eq(vendor.id, destinationId), notDeleted(vendor)));
    },
  },
} satisfies Record<CoverEntity | LogoEntity, SingularImageOwnerBinding>;

export const isSingularImageOwner = (
  entity: string,
): entity is keyof typeof singularImageOwnerBindings =>
  entity in singularImageOwnerBindings;

export const attachImportedSingularImage = async (
  db: Database,
  entity: keyof typeof singularImageOwnerBindings,
  destinationCode: string,
  imageCode: string,
  replaceConfirmed: boolean,
): Promise<void> =>
  singularImageOwnerBindings[entity].attach(
    db,
    destinationCode,
    imageCode,
    replaceConfirmed,
  );

export const importedSingularImageIsOccupied = (
  db: Database,
  entity: keyof typeof singularImageOwnerBindings,
  destinationCode: string,
): Promise<boolean> =>
  singularImageOwnerBindings[entity].occupied(db, destinationCode);
