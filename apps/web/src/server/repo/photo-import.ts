import type { Entity } from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import {
  type CoverEntity,
  entityManifest,
  isGalleryEntity,
  type GalleryEntity,
  type LogoEntity,
} from "@cubby/schemas/entity-manifest";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { z } from "zod";

import {
  localPhotoAnalysisSchema,
  type LocalPhotoAnalysis,
  type PhotoImportCommitInput,
} from "~/contracts/photo-import.contract";
import type { Database } from "~/server/db";
import { aiAnalysis, cookbook, image, vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  associatePendingImages,
  getDb,
  imageJoinBindings,
  nextImageSortOrder,
  notDeleted,
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

/** Lock every selected image row for the duration of the import transaction. */
export async function lockImportImageRows(
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
    .where(and(inArray(image.shortcode, [...shortcodes]), notDeleted(image)))
    .for("update");
}

/**
 * Activate all newly staged images as one final database operation. Integrity
 * metadata is written with the same UPDATE so a failed commit cannot expose a
 * half-verified image. The caller compares the returned count with its locked
 * PENDING set and rolls the transaction back on any mismatch.
 */
export async function activateImportImages(
  db: Database,
  staged: readonly {
    row: ImportImageRow;
    integrity: {
      width: number | null;
      height: number | null;
      detectedContentType: string;
      sha256: string;
      renderStatus: "verified" | "failed";
      storageStatus: "available";
      verifiedAt: Date;
    };
  }[],
): Promise<number> {
  if (staged.length === 0) return 0;
  const client = getDb(db);
  const ids = staged.map(({ row }) => row.id);
  const byId = <T>(
    fallback: AnyColumn,
    pick: (entry: (typeof staged)[number]) => T,
  ) =>
    sql<T>`case ${sql.join(
      staged.map(
        (entry) => sql`when ${image.id} = ${entry.row.id} then ${pick(entry)}`,
      ),
      sql.raw(" "),
    )} else ${fallback} end`;
  const updated = await client
    .update(image)
    .set({
      width: byId(image.width, (entry) => entry.integrity.width),
      height: byId(image.height, (entry) => entry.integrity.height),
      detectedContentType: byId(
        image.detectedContentType,
        (entry) => entry.integrity.detectedContentType,
      ),
      sha256: byId(image.sha256, (entry) => entry.integrity.sha256),
      renderStatus: byId(
        image.renderStatus,
        (entry) => entry.integrity.renderStatus,
      ),
      storageStatus: byId(
        image.storageStatus,
        (entry) => entry.integrity.storageStatus,
      ),
      verifiedAt: byId(image.verifiedAt, (entry) => entry.integrity.verifiedAt),
      status: "UPLOADED",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(image.id, ids),
        eq(image.status, "PENDING"),
        notDeleted(image),
      ),
    )
    .returning({ id: image.id });
  return updated.length;
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

/**
 * Newest non-deleted `photo-local-analysis` row for an image, or `null` if
 * none exists or the stored `result` no longer matches the current schema
 * (an old row from a retired `analysisVersion` shape) — the diagnostics tab
 * treats either as "nothing persisted yet" rather than a server error.
 */
export async function getLocalImageAnalysis(
  db: Database,
  imageId: string,
): Promise<LocalPhotoAnalysis | null> {
  const [row] = await getDb(db)
    .select({ result: aiAnalysis.result })
    .from(aiAnalysis)
    .where(
      and(
        eq(aiAnalysis.entityType, "image"),
        eq(aiAnalysis.entityId, imageId),
        eq(aiAnalysis.feature, "photo-local-analysis"),
        isNull(aiAnalysis.deletedAt),
      ),
    )
    .orderBy(desc(aiAnalysis.promptVersion), desc(aiAnalysis.updatedAt))
    .limit(1);
  if (!row) return null;
  const parsed = localPhotoAnalysisSchema.safeParse(row.result);
  return parsed.success ? parsed.data : null;
}

export async function withPhotoImportTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
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
    { activate: false },
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
