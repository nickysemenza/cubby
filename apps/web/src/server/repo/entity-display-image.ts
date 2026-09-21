import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { type Entity, entityRefKey, entitySchema } from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import {
  allEntities,
  entityManifest,
  imageDisplayBindings,
  isGalleryEntity,
  localRelationshipByKey,
  type CoverEntity,
  type GalleryEntity,
  type LogoEntity,
} from "@cubby/schemas/entity-manifest";
import type { EntityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { cookbook, image, vendor } from "~/server/db/schema";
import {
  imageJoinBindings,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { mapImages } from "~/server/repo/database-helpers/transform";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { compileTraversal } from "~/server/repo/relatedness/traversal";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { loadImageRepresentations } from "./image-processing";
import { hydrateImageReadProjection } from "./image-read-projection";

/** A private database identity used only while hydrating public read models. */
export interface EntityDisplayImageRef {
  entityType: Entity;
  entityId: string;
}

const DISPLAY_IMAGE_ENTITIES = new Set<Entity>(entitySchema.options);

type DisplaySource = Readonly<{
  entity: Entity;
  target: Entity;
  priority: number;
  ordering: "declared" | "newest" | "oldest";
  path: readonly RelationshipPathStep[];
}>;

type DisplayPath = Readonly<{
  target: Entity;
  steps: readonly RelationshipPathStep[];
}>;

/**
 * A display source is a manifest relationship path followed by the target's
 * direct Image relationship. This deliberately never re-enters the display
 * resolver: borrowed images are terminal presentation evidence, not another
 * entity's recursively-derived displayImages.
 */
const imageRelationshipSteps = (
  entity: Entity,
): readonly RelationshipPathStep[] => {
  const imageRelation = entityManifest[entity].relationships.filter(
    (relation) => relation.target === "image",
  );
  if (imageRelation.length !== 1) {
    throw new Error(
      `Image-owning ${entity} must declare exactly one direct image relationship`,
    );
  }
  return localRelationshipByKey(entity, imageRelation[0]!.key).provenance.steps;
};

const displayPathSteps = (
  entity: Entity,
  relationPath: readonly string[],
): DisplayPath => {
  let current = entity;
  const steps: RelationshipPathStep[] = [];
  for (const key of relationPath) {
    const relation = localRelationshipByKey(current, key);
    steps.push(...relation.provenance.steps);
    current = relation.target;
  }
  return { target: current, steps };
};

/** Generated bindings are validated by the manifest compiler; compiling them
 * once here turns every declared source into a bounded SQL UNION arm. */
const DISPLAY_SOURCES: readonly DisplaySource[] = allEntities.flatMap(
  (entity) =>
    imageDisplayBindings[entity].map((binding) => {
      const relationship = displayPathSteps(entity, binding.relationPath);
      if (relationship.target !== binding.targetEntity) {
        throw new Error(
          `Image display binding ${entity}.${binding.relationPath.join(".")} targets ${binding.targetEntity}, not ${relationship.target}`,
        );
      }
      return {
        entity,
        target: relationship.target,
        priority: binding.priority,
        ordering: binding.ordering,
        path: [
          ...relationship.steps,
          ...imageRelationshipSteps(relationship.target),
        ],
      };
    }),
);

const sourceAlias = (value: string) => value.replaceAll(/[^A-Za-z0-9]/g, "_");

const rootLiveCondition = (entity: Entity, alias: string): SQL =>
  entityManifest[entity].softDelete
    ? sql`${sql.raw(`${alias}."deletedAt"`)} IS NULL`
    : sql`TRUE`;

const optionalColumn = (alias: string, column: string): SQL =>
  sql.raw(`${alias}."${column}"`);

/** Nutrition/package labels are evidence on a Product, never its cover.
 * Legacy joins have a null purpose and retain their historical item behavior. */
const displayAttachmentCondition = (target: Entity, alias: string): SQL =>
  target === "product"
    ? sql`COALESCE(${optionalColumn(alias, "purpose")}, 'item') <> 'label'`
    : sql`TRUE`;

/**
 * Direct storage is also resolved through its manifest relationship. Gallery
 * ordering remains the join row's sortOrder/createdAt; covers and logos have
 * no join row and use the owner creation time as their stable tie breaker.
 */
const directStorageBranch = (entity: Entity): SQL | null => {
  const storage = entityManifest[entity].images.storage;
  if (storage === false) return null;
  const traversal = compileTraversal(
    entity,
    imageRelationshipSteps(entity),
    `display_direct_${sourceAlias(entity)}`,
    { root: "s", leaf: "i" },
  );
  const attachmentHop = traversal.hops.at(-2);
  const gallery = storage === "gallery";
  if (gallery && attachmentHop === undefined) {
    throw new Error(`Gallery ${entity} has no image attachment hop`);
  }
  const sortOrder = gallery
    ? optionalColumn(attachmentHop!.alias, "sortOrder")
    : sql`0`;
  const createdAt = gallery
    ? optionalColumn(attachmentHop!.alias, "createdAt")
    : optionalColumn("s", "createdAt");
  return sql`
        SELECT i.key, i.shortcode, 0 AS priority,
               NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId",
               ${sortOrder} AS "sortOrder", ${createdAt} AS "createdAt", i.id AS "imageId"
        FROM ${sql.raw(`"${traversal.rootTable}"`)} s
        ${traversal.joins}
        WHERE refs."entityType" = ${entity}
          AND s.id = refs."entityId"
          AND ${rootLiveCondition(entity, "s")}
          AND ${displayAttachmentCondition(entity, attachmentHop?.alias ?? "")}
          AND ${displayableImageSql("i")}`;
};

/**
 * A borrowed source stops at the target's direct attachment. Its relation
 * group is ordered by the final relation hop when one exists, otherwise by
 * the target record itself. That preserves declared link order while making
 * newest/oldest policy data-driven rather than an entity-name switch.
 */
const displaySourceBranch = (source: DisplaySource, index: number): SQL => {
  const traversal = compileTraversal(
    source.entity,
    source.path,
    `display_source_${index}_${sourceAlias(source.entity)}`,
    { root: "s", leaf: "i" },
  );
  const targetImageSteps = imageRelationshipSteps(source.target).length;
  const targetHopIndex = traversal.hops.length - targetImageSteps - 1;
  const groupHop = traversal.hops.at(targetHopIndex);
  const groupAlias = groupHop?.alias ?? "s";
  const attachmentHop = traversal.hops.at(-2);
  const targetStorage = entityManifest[source.target].images.storage;
  const targetGallery = targetStorage === "gallery";
  if (targetGallery && attachmentHop === undefined) {
    throw new Error(
      `Gallery display source ${source.target} has no attachment hop`,
    );
  }
  const groupCreatedAt =
    source.ordering === "newest"
      ? sql`to_timestamp(-EXTRACT(EPOCH FROM ${optionalColumn(groupAlias, "createdAt")}))`
      : optionalColumn(groupAlias, "createdAt");
  const sortOrder = targetGallery
    ? optionalColumn(attachmentHop!.alias, "sortOrder")
    : sql`0`;
  const createdAt = targetGallery
    ? optionalColumn(attachmentHop!.alias, "createdAt")
    : optionalColumn(groupAlias, "createdAt");
  return sql`
        SELECT i.key, i.shortcode, ${source.priority} AS priority,
               ${groupCreatedAt} AS "groupCreatedAt", ${optionalColumn(groupAlias, "id")} AS "groupId",
               ${sortOrder} AS "sortOrder", ${createdAt} AS "createdAt", i.id AS "imageId"
        FROM ${sql.raw(`"${traversal.rootTable}"`)} s
        ${traversal.joins}
        WHERE refs."entityType" = ${source.entity}
          AND s.id = refs."entityId"
          AND ${rootLiveCondition(source.entity, "s")}
          AND ${displayAttachmentCondition(source.target, attachmentHop?.alias ?? "")}
          AND ${displayableImageSql("i")}`;
};

const DISPLAY_BRANCHES = [
  ...allEntities.flatMap((entity) => {
    const branch = directStorageBranch(entity);
    return branch === null ? [] : [{ entity, branch }];
  }),
  ...DISPLAY_SOURCES.map((source, index) => ({
    entity: source.entity,
    branch: displaySourceBranch(source, index),
  })),
];

const displayImageRowSchema = z.object({
  entityType: entitySchema,
  entityId: z.string(),
  images: z.array(z.object({ id: imageShortcode, key: z.string() })),
});

/**
 * Resolve every displayable image, in display order, for a mixed batch of
 * private entity refs.
 *
 * This is THE display-image policy: list rows' `displayImages`, search hits,
 * entity-link hover cards and the audit log all read it, and no client derives
 * a cover itself. An entity's own gallery/cover comes first (priority 0),
 * mechanically for every `GalleryEntity` — see {@link ownGalleryUnionBranch}.
 * Direct storage always wins. Explicit relationship arms then supply truthful
 * fallback imagery without recursively resolving another entity's
 * `displayImages`; that keeps reciprocal relationships such as recipe and meal
 * finite. Callers keep UUIDs private, map the returned summaries onto public
 * DTOs, and use a semantic entity mark when a ref resolves to nothing.
 */
async function resolveUniversalEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  const supported = [
    ...new Map(
      refs
        .filter((ref) => DISPLAY_IMAGE_ENTITIES.has(ref.entityType))
        .map((ref) => [entityRefKey(ref.entityType, ref.entityId), ref]),
    ).values(),
  ];
  if (supported.length === 0) return new Map();

  const values = sql.join(
    supported.map(
      (ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`,
    ),
    sql`, `,
  );
  // Unrelated entity arms still incur planner/JIT costs even when their WHERE
  // clauses can never match. Compile only the source types in this batch.
  const sourceTypes = new Set(supported.map((ref) => ref.entityType));
  const displayBranches = DISPLAY_BRANCHES.filter(({ entity }) =>
    sourceTypes.has(entity),
  ).map(({ branch }) => branch);
  const borrowedImages = displayBranches.length
    ? sql`UNION ALL ${sql.join(displayBranches, sql` UNION ALL `)}`
    : sql``;
  const result = await unwrapDb(db).execute(sql`
    WITH refs("entityType", "entityId") AS (VALUES ${values})
    SELECT refs."entityType", refs."entityId"::text AS "entityId", (
      SELECT COALESCE(
        json_agg(
          json_build_object('id', candidates.shortcode, 'key', candidates.key)
          ORDER BY candidates.priority, candidates."groupCreatedAt", candidates."groupId",
                   candidates."sortOrder", candidates."createdAt", candidates."imageId"
        ),
        '[]'::json
      )
      FROM (
        SELECT DISTINCT ON (raw_candidates."imageId") raw_candidates.*
        FROM (
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", i."createdAt", i.id AS "imageId"
        FROM "Image" i
        WHERE refs."entityType" = 'image' AND i.id = refs."entityId"
          AND i."deletedAt" IS NULL AND ${displayableImageSql("i")}
        ${borrowedImages}
        ) raw_candidates
        ORDER BY raw_candidates."imageId", raw_candidates.priority,
                 raw_candidates."groupCreatedAt", raw_candidates."groupId",
                 raw_candidates."sortOrder", raw_candidates."createdAt"
      ) candidates
    ) AS images
    FROM refs
  `);

  const rows = z.array(displayImageRowSchema).parse(result.rows);
  const representations = await loadImageRepresentations(
    db,
    rows.flatMap((row) => row.images.map((img) => img.id)),
  );
  return new Map(
    rows.map((row) => [
      entityRefKey(row.entityType, row.entityId),
      row.images.map((img) => ({
        id: img.id,
        url: getR2PublicUrl(img.key),
        representations: representations.get(img.id),
      })),
    ]),
  );
}

async function resolveEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  return resolveUniversalEntityDisplayImageLists(db, refs);
}

const publicEntityRowSchema = z.looseObject({ id: z.string() });
type PublicEntityRow = z.output<typeof publicEntityRowSchema>;

type SingleImageEntity = CoverEntity | LogoEntity;
type SingleImageBinding = {
  table: typeof cookbook | typeof vendor;
  imageIdColumn: typeof cookbook.coverImageId | typeof vendor.logoImageId;
  role: "cover" | "logo";
};

/** Exhaustive registry for direct images stored on the owning row. */
const singleImageBindings = {
  cookbook: {
    table: cookbook,
    imageIdColumn: cookbook.coverImageId,
    role: "cover",
  },
  vendor: {
    table: vendor,
    imageIdColumn: vendor.logoImageId,
    role: "logo",
  },
} as const satisfies Record<SingleImageEntity, SingleImageBinding>;

const isSingleImageEntity = (entity: Entity): entity is SingleImageEntity => {
  const storage = entityManifest[entity].imageStorage;
  return storage === "cover" || storage === "logo";
};

const galleryAttachments = async (
  db: Database | DrizzleTransaction,
  entityType: GalleryEntity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  if (entityIds.length === 0) return new Map();
  const binding = imageJoinBindings[entityType];
  const joinTable = binding.table;
  const rows = await unwrapDb(db)
    .select({
      entityId: binding.parentIdColumn,
      ...getTableColumns(image),
    })
    .from(joinTable)
    .innerJoin(image, eq(image.id, joinTable.imageId))
    .where(
      and(
        inArray(binding.parentIdColumn, [...entityIds]),
        notDeleted(joinTable),
        notDeleted(image),
      ),
    )
    .orderBy(
      asc(binding.parentIdColumn),
      asc(joinTable.sortOrder),
      asc(joinTable.createdAt),
      asc(image.id),
    );
  const attachments = new Map<string, EntityAttachmentRead[]>();
  const representations = await loadImageRepresentations(
    db,
    rows.map((row) => row.shortcode),
  );
  mapImages(rows).forEach((item, index) => {
    const row = rows[index];
    if (!row) return;
    const entityId = String(row.entityId);
    const list = attachments.get(entityId) ?? [];
    list.push({
      ...item,
      representations: representations.get(item.id),
      role: "attachment",
      position: list.length,
    });
    attachments.set(entityId, list);
  });
  return attachments;
};

const singleImageAttachments = async (
  db: Database | DrizzleTransaction,
  entityType: SingleImageEntity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  if (entityIds.length === 0) return new Map();
  const binding: SingleImageBinding = singleImageBindings[entityType];
  const rows = await unwrapDb(db)
    .select({ entityId: binding.table.id, ...getTableColumns(image) })
    .from(binding.table)
    .innerJoin(image, eq(image.id, binding.imageIdColumn))
    .where(
      and(
        sql`${binding.table.id} IN (${sql.join(
          entityIds.map((entityId) => sql`${entityId}::uuid`),
          sql`, `,
        )})`,
        notDeleted(binding.table),
        notDeleted(image),
      ),
    );
  const attachments = new Map<string, EntityAttachmentRead[]>();
  const representations = await loadImageRepresentations(
    db,
    rows.map((row) => row.shortcode),
  );
  mapImages(rows).forEach((item, index) => {
    const row = rows[index];
    if (!row) return;
    attachments.set(String(row.entityId), [
      {
        ...item,
        representations: representations.get(item.id),
        role: binding.role,
        position: 0,
      },
    ]);
  });
  return attachments;
};

/** Resolve directly owned files from the storage declared by the manifest. */
export const resolveEntityAttachments = async (
  db: Database | DrizzleTransaction,
  entityType: Entity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  const storage = entityManifest[entityType].imageStorage;
  if (storage === false) return new Map();
  if (isGalleryEntity(entityType))
    return galleryAttachments(db, entityType, entityIds);
  if (isSingleImageEntity(entityType))
    return singleImageAttachments(db, entityType, entityIds);
  throw new Error(
    `No direct-attachment binding for ${entityType} (${storage})`,
  );
};

/** Universal public read projection. One shortcode lookup and one image query per batch. */
export async function withUniversalEntityMedia<
  E extends Exclude<Entity, "usda-food">,
>(
  db: Database | DrizzleTransaction,
  entityType: E,
  rows: readonly unknown[],
  detail: boolean,
): Promise<
  Array<
    PublicEntityRow & {
      displayImages: DisplayImageSummary[];
      attachments?: EntityAttachmentRead[];
    }
  >
> {
  const publicRows = rows.map((row) => publicEntityRowSchema.parse(row));
  const resolved = await resolveLiveShortcodes(
    db,
    publicRows.map((row) => row.id),
    entityType,
  );
  const refs = publicRows.flatMap((row) => {
    const entityId = resolved.get(row.id);
    return entityId === undefined ? [] : [{ entityType, entityId }];
  });
  const [lists, attachments] = await Promise.all([
    resolveEntityDisplayImageLists(db, refs),
    detail
      ? resolveEntityAttachments(
          db,
          entityType,
          refs.map((ref) => ref.entityId),
        )
      : Promise.resolve(new Map<string, EntityAttachmentRead[]>()),
  ]);
  return hydrateImageReadProjection(
    db,
    publicRows.map((row) => {
      const entityId = resolved.get(row.id);
      const displayImages = entityId
        ? (lists.get(entityRefKey(entityType, entityId)) ?? [])
        : [];
      if (!detail) return { ...row, displayImages };
      const projected = {
        ...row,
        displayImages,
        attachments: entityId ? (attachments.get(entityId) ?? []) : [],
      };
      // Purchase documents and Product item/label galleries retain attachment
      // metadata in their specialized projections. Generic attachments still
      // expose every file without replacing those domain-shaped galleries.
      return entityType !== "purchase" &&
        entityType !== "product" &&
        "images" in row
        ? { ...projected, images: projected.attachments }
        : projected;
    }),
  );
}

/**
 * The cover only — `[0]` of {@link resolveEntityDisplayImageLists} — for
 * callers that render a single mark (search hits, hover cards, audit rows).
 * Refs that resolve to no image are absent from the map.
 */
export async function resolveEntityDisplayImages(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, ImageUrlSummary>> {
  const lists = await resolveEntityDisplayImageLists(db, refs);
  return new Map(
    [...lists].flatMap(([key, images]) =>
      images[0]
        ? [
            [
              key,
              {
                url: images[0].representations?.preferred ?? images[0].url,
                representations: images[0].representations,
              },
            ],
          ]
        : [],
    ),
  );
}

/**
 * Attach `displayImages` to a page of list rows: one resolver call for the
 * page, rows keyed by private id, mapped to their public shape by `toOut`.
 * Every `displayImages` manifest entity's list function goes through this,
 * so the list contract (web thumbnails, native rows) has exactly one source.
 */
export async function withDisplayImages<Row extends { id: string }, Out>(
  db: Database | DrizzleTransaction,
  entityType: Entity,
  rows: readonly Row[],
  // Mappers that parse their row against the list schema take the images as
  // an argument so the parse sees them; the spread below covers the rest.
  toOut: (row: Row, displayImages: DisplayImageSummary[]) => Out,
): Promise<Array<Out & { displayImages: DisplayImageSummary[] }>> {
  const lists = await resolveEntityDisplayImageLists(
    db,
    rows.map((row) => ({ entityType, entityId: row.id })),
  );
  return hydrateImageReadProjection(
    db,
    rows.map((row) => {
      const displayImages = lists.get(entityRefKey(entityType, row.id)) ?? [];
      return { ...toOut(row, displayImages), displayImages };
    }),
  );
}
