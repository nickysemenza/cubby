import {
  displayImagesField,
  type DisplayImageSummary,
} from "@cubby/schemas/display-images";
import {
  type Entity,
  type EntityRef as PublicEntityRef,
  entityRefKey,
  entitySchema,
} from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import {
  allEntities,
  entityManifest,
  imageDisplayBindings,
  localRelationshipByKey,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import type { EntityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { imageShortcode } from "@cubby/schemas/identifiers";
import type {
  ImageRepresentations,
  ImageUrlSummary,
} from "@cubby/schemas/image-summary";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project";
import { parseShortcode } from "@cubby/shared";
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
import { entityAttachment, image } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { mapImages } from "~/server/repo/database-helpers/transform";
import { previousShortcodesFor } from "~/server/repo/entity-identity";
import { effectiveExpenseProjectSql } from "~/server/repo/expense-inheritance";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { compileTraversal } from "~/server/repo/relatedness/traversal";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import {
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  loadImageRepresentations,
} from "./image-processing";
import { hydrateImageReadProjection } from "./image-read-projection";

/** A private database identity used only while hydrating public read models. */
export interface EntityDisplayImageRef {
  entityKind: Entity;
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

type DisplayBranch = Readonly<{
  entity: Entity;
  branch: SQL;
  usesExpenseProjectRelation: boolean;
}>;

const EXPENSE_PROJECT_RELATION = "display_expense_project";

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
        path:
          relationship.target === "image"
            ? relationship.steps
            : [
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
        WHERE refs."entityKind" = ${entity}
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
const displaySourceBranch = (
  source: DisplaySource,
  index: number,
): Pick<DisplayBranch, "branch" | "usesExpenseProjectRelation"> => {
  const traversal = compileTraversal(
    source.entity,
    source.path,
    `display_source_${index}_${sourceAlias(source.entity)}`,
    { root: "s", leaf: "i", expenseProjectRelation: EXPENSE_PROJECT_RELATION },
  );
  const targetImageSteps =
    source.target === "image"
      ? 0
      : imageRelationshipSteps(source.target).length;
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
  return {
    usesExpenseProjectRelation: traversal.usesExpenseProjectRelation,
    branch: sql`
        SELECT i.key, i.shortcode, ${source.priority} AS priority,
               ${groupCreatedAt} AS "groupCreatedAt", ${optionalColumn(groupAlias, "id")} AS "groupId",
               ${sortOrder} AS "sortOrder", ${createdAt} AS "createdAt", i.id AS "imageId"
        FROM ${sql.raw(`"${traversal.rootTable}"`)} s
        ${traversal.joins}
        WHERE refs."entityKind" = ${source.entity}
          AND s.id = refs."entityId"
          AND ${rootLiveCondition(source.entity, "s")}
          AND ${displayAttachmentCondition(source.target, attachmentHop?.alias ?? "")}
          AND ${displayableImageSql("i")}`,
  };
};

const DISPLAY_BRANCHES: readonly DisplayBranch[] = [
  ...allEntities.flatMap((entity) => {
    const branch = directStorageBranch(entity);
    return branch === null
      ? []
      : [{ entity, branch, usesExpenseProjectRelation: false }];
  }),
  ...DISPLAY_SOURCES.map((source, index) => ({
    entity: source.entity,
    ...displaySourceBranch(source, index),
  })),
];

/** Filter/order mixed lists by the same direct and borrowed media as thumbnails. */
export const entityDisplayImagePresenceSql = (entity: Entity, id: SQL): SQL => {
  const selected = DISPLAY_BRANCHES.filter(
    (branch) => branch.entity === entity,
  );
  const expenseRelation = selected.some(
    (branch) => branch.usesExpenseProjectRelation,
  )
    ? sql`, "${sql.raw(EXPENSE_PROJECT_RELATION)}" AS (
        SELECT e.*, ${effectiveExpenseProjectSql("e")} AS "effectiveProjectId"
        FROM "Expense" e WHERE e."deletedAt" IS NULL
          AND e."lineKind" = 'principal' AND e."productId" IS NOT NULL
      )`
    : sql``;
  const branches = selected.map(({ branch }) => branch);
  if (entity === "image")
    branches.push(sql`
    SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt",
      NULL::uuid AS "groupId", 0 AS "sortOrder", i."createdAt", i.id AS "imageId"
    FROM "Image" i WHERE i.id = refs."entityId" AND i."deletedAt" IS NULL
      AND ${displayableImageSql("i")}`);
  if (branches.length === 0) return sql`false`;
  return sql`EXISTS (
    WITH refs AS (SELECT ${entity}::text AS "entityKind", ${id} AS "entityId")
    ${expenseRelation}
    SELECT 1 FROM refs JOIN LATERAL (
      ${sql.join(branches, sql` UNION ALL `)}
    ) candidates ON true
  )`;
};

const displayImageRowSchema = z.object({
  entityKind: entitySchema,
  entityId: z.string(),
  refKey: z.string(),
  images: z.array(
    z.object({
      id: imageShortcode,
      key: z.string(),
      useOriginal: z.boolean(),
      derivativeKey: z.string().nullable(),
    }),
  ),
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
async function resolveDisplayImageListsFromSqlRefs(
  db: Database | DrizzleTransaction,
  refsSql: SQL,
  sourceTypes: ReadonlySet<Entity>,
): Promise<Map<string, DisplayImageSummary[]>> {
  // Unrelated entity arms still incur planner/JIT costs even when their WHERE
  // clauses can never match. Compile only the source types in this batch.
  const selectedBranches = DISPLAY_BRANCHES.filter(({ entity }) =>
    sourceTypes.has(entity),
  );
  const displayBranches = selectedBranches.map(({ branch }) => branch);
  // Explicit and purchase assignments identify page candidates through their
  // indexes. The effective-project expression still decides precedence; food
  // fallback requires the wider set only when the household project is in refs.
  const expenseProjectRelation = selectedBranches.some(
    ({ usesExpenseProjectRelation }) => usesExpenseProjectRelation,
  )
    ? sql`, "${sql.raw(EXPENSE_PROJECT_RELATION)}" AS MATERIALIZED (
        SELECT e.*, ${effectiveExpenseProjectSql("e")} AS "effectiveProjectId"
        FROM "Expense" e
        WHERE e."deletedAt" IS NULL
          AND e."lineKind" = 'principal'
          AND e."productId" IS NOT NULL
          AND (
            e."projectId" IN (
              SELECT r."entityId" FROM refs r WHERE r."entityKind" = 'project'
            )
            OR e."purchaseId" IN (
              SELECT purchase.id
              FROM "Purchase" purchase
              JOIN refs r ON r."entityId" = purchase."defaultProjectId"
              WHERE r."entityKind" = 'project'
                AND purchase."deletedAt" IS NULL
            )
            OR EXISTS (
              SELECT 1
              FROM refs r JOIN "Project" household ON household.id = r."entityId"
              WHERE r."entityKind" = 'project'
                AND household."shortcode" = ${HOUSEHOLD_PROJECT_SHORTCODE}
                AND household."deletedAt" IS NULL
            )
          )
      )`
    : sql``;
  const borrowedImages = displayBranches.length
    ? sql`UNION ALL ${sql.join(displayBranches, sql` UNION ALL `)}`
    : sql``;
  const result = await unwrapDb(db).execute(sql`
    WITH ${refsSql}
    ${expenseProjectRelation}
    SELECT refs."entityKind", refs."entityId"::text AS "entityId", refs."refKey", (
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', candidates.shortcode,
            'key', candidates.key,
            'useOriginal', selected_image."useOriginal",
            'derivativeKey', derivative.key
          )
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
        WHERE refs."entityKind" = 'image' AND i.id = refs."entityId"
          AND i."deletedAt" IS NULL AND ${displayableImageSql("i")}
        ${borrowedImages}
        ) raw_candidates
        ORDER BY raw_candidates."imageId", raw_candidates.priority,
                 raw_candidates."groupCreatedAt", raw_candidates."groupId",
                 raw_candidates."sortOrder", raw_candidates."createdAt"
      ) candidates
      JOIN "Image" selected_image ON selected_image.id = candidates."imageId"
      LEFT JOIN "ImageDerivative" derivative
        ON derivative."imageId" = selected_image.id
       AND derivative.purpose = 'transparent'
       AND derivative."sourceContentHash" = selected_image.sha256
       AND derivative."processorRevision" = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION}
       AND derivative.status = 'ready'
       AND derivative."deletedAt" IS NULL
    ) AS images
    FROM refs
  `);

  const rows = z.array(displayImageRowSchema).parse(result.rows);
  return new Map(
    rows.map((row) => [
      row.refKey,
      row.images.map((img) => {
        const original = getR2PublicUrl(img.key);
        const transparent = img.derivativeKey
          ? getR2PublicUrl(img.derivativeKey)
          : null;
        const preferTransparent = !img.useOriginal && transparent !== null;
        return {
          id: img.id,
          url: original,
          representations: {
            original,
            transparent,
            preferred: preferTransparent ? transparent : original,
            preferredKind: preferTransparent
              ? ("transparent" as const)
              : ("original" as const),
          },
        };
      }),
    ]),
  );
}

async function resolveUniversalEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  const supported = [
    ...new Map(
      refs
        .filter((ref) => DISPLAY_IMAGE_ENTITIES.has(ref.entityKind))
        .map((ref) => [entityRefKey(ref.entityKind, ref.entityId), ref]),
    ).values(),
  ];
  if (supported.length === 0) return new Map();
  const values = sql.join(
    supported.map(
      (ref) =>
        sql`(${ref.entityKind}::text, ${ref.entityId}::uuid, ${entityRefKey(ref.entityKind, ref.entityId)}::text)`,
    ),
    sql`, `,
  );
  return resolveDisplayImageListsFromSqlRefs(
    db,
    sql`refs("entityKind", "entityId", "refKey") AS (VALUES ${values})`,
    new Set(supported.map((ref) => ref.entityKind)),
  );
}

/** Public shortcodes join durable identities inside the image query. */
export async function resolvePublicEntityDisplayImages(
  db: Database | DrizzleTransaction,
  refs: readonly PublicEntityRef[],
): Promise<Map<string, ImageUrlSummary>> {
  const supported = [
    ...new Map(
      refs.flatMap((ref) => {
        if (!shortcodeEntities.some((entity) => entity === ref.entityKind))
          return [];
        const parsed = parseShortcode(ref.entityId);
        if (!parsed || parsed.type !== ref.entityKind) return [];
        const refKey = entityRefKey(ref.entityKind, ref.entityId);
        return [
          [refKey, { ...ref, shortcode: parsed.shortcode, refKey }] as const,
        ];
      }),
    ).values(),
  ];
  if (supported.length === 0) return new Map();
  const values = sql.join(
    supported.map(
      (ref) =>
        sql`(${ref.entityKind}::text, ${ref.shortcode}::text, ${ref.refKey}::text)`,
    ),
    sql`, `,
  );
  const lists = await resolveDisplayImageListsFromSqlRefs(
    db,
    sql`input_refs("entityKind", "shortcode", "refKey") AS (VALUES ${values}),
        refs("entityKind", "entityId", "refKey") AS (
          SELECT input_refs."entityKind", identity.id, input_refs."refKey"
          FROM input_refs
          JOIN "Entity" identity ON identity.shortcode = input_refs.shortcode
            AND identity.kind = input_refs."entityKind"
            AND identity."deletedAt" IS NULL
            AND identity."mergedIntoId" IS NULL
        )`,
    new Set(supported.map((ref) => ref.entityKind)),
  );
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
            ] as const,
          ]
        : [],
    ),
  );
}

export async function resolveEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  return resolveUniversalEntityDisplayImageLists(db, refs);
}

const publicEntityRowSchema = z.looseObject({ id: z.string() });
const resolvedListMediaSchema = z.object({ displayImages: displayImagesField });
type PublicEntityRow = z.output<typeof publicEntityRowSchema>;

/** Reuse only the authoritative media resolved for this read batch. */
const resolvedImageRepresentations = (
  lists: ReadonlyMap<string, readonly DisplayImageSummary[]>,
  attachments?: ReadonlyMap<string, readonly EntityAttachmentRead[]>,
): Map<string, ImageRepresentations> => {
  const representations = new Map<string, ImageRepresentations>();
  for (const group of [lists, attachments]) {
    if (!group) continue;
    for (const images of group.values()) {
      for (const image of images) {
        if (image.representations) {
          representations.set(image.id, image.representations);
        }
      }
    }
  }
  return representations;
};

/** Every direct attachment of the given subjects, in display order. */
const directAttachments = async (
  db: Database | DrizzleTransaction,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  if (entityIds.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({
      entityId: entityAttachment.entityId,
      attachmentRole: entityAttachment.role,
      ...getTableColumns(image),
    })
    .from(entityAttachment)
    .innerJoin(image, eq(image.id, entityAttachment.imageId))
    .where(
      and(
        inArray(entityAttachment.entityId, [...entityIds]),
        notDeleted(entityAttachment),
        notDeleted(image),
      ),
    )
    .orderBy(
      asc(entityAttachment.entityId),
      asc(entityAttachment.sortOrder),
      asc(entityAttachment.createdAt),
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
    const list = attachments.get(row.entityId) ?? [];
    list.push({
      ...item,
      representations: representations.get(item.id),
      role: row.attachmentRole,
      position: list.length,
    });
    attachments.set(row.entityId, list);
  });
  return attachments;
};

/** Resolve directly owned files from the storage declared by the manifest. */
export const resolveEntityAttachments = async (
  db: Database | DrizzleTransaction,
  entityKind: Entity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> =>
  entityManifest[entityKind].imageStorage === false
    ? new Map()
    : directAttachments(db, entityIds);

/** Universal public read projection. One shortcode lookup and one image query per batch. */
export async function withUniversalEntityMedia<
  E extends Exclude<Entity, "usda-food">,
>(
  db: Database | DrizzleTransaction,
  entityKind: E,
  rows: readonly unknown[],
  detail: boolean,
): Promise<
  Array<
    PublicEntityRow & {
      displayImages: DisplayImageSummary[];
      attachments?: EntityAttachmentRead[];
      redirectedFrom?: string | null;
      previousShortcodes?: string[];
    }
  >
> {
  const publicRows = rows.map((row) => publicEntityRowSchema.parse(row));
  const resolved = await resolveLiveShortcodes(
    db,
    publicRows.map((row) => row.id),
    entityKind,
  );
  const refs = publicRows.flatMap((row) => {
    const entityId = resolved.get(row.id);
    return entityId === undefined ? [] : [{ entityKind, entityId }];
  });
  const entityIds = refs.map((ref) => ref.entityId);
  const [lists, attachments, previousShortcodes] = await Promise.all([
    resolveEntityDisplayImageLists(db, refs),
    detail
      ? resolveEntityAttachments(db, entityKind, entityIds)
      : Promise.resolve(new Map<string, EntityAttachmentRead[]>()),
    detail
      ? previousShortcodesFor(db, entityIds)
      : Promise.resolve(new Map<string, string[]>()),
  ]);
  return hydrateImageReadProjection(
    db,
    publicRows.map((row) => {
      const entityId = resolved.get(row.id);
      const displayImages = entityId
        ? (lists.get(entityRefKey(entityKind, entityId)) ?? [])
        : [];
      if (!detail) return { ...row, displayImages };
      const projected = {
        ...row,
        displayImages,
        attachments: entityId ? (attachments.get(entityId) ?? []) : [],
        // The kernel's get sets this when it followed a merge redirect.
        redirectedFrom: null,
        previousShortcodes: entityId
          ? (previousShortcodes.get(entityId) ?? [])
          : [],
      };
      // Purchase documents and Product item/label galleries retain attachment
      // metadata in their specialized projections. Generic attachments still
      // expose every file without replacing those domain-shaped galleries.
      return entityKind !== "purchase" &&
        entityKind !== "product" &&
        "images" in row
        ? { ...projected, images: projected.attachments }
        : projected;
    }),
    resolvedImageRepresentations(lists, attachments),
  );
}

/** Repository list projections that already carry resolved images need no
 * shortcode lookup or second display-image query at the kernel boundary. */
export async function withListEntityMedia<
  E extends Exclude<Entity, "usda-food">,
  Row,
>(
  db: Database | DrizzleTransaction,
  entityKind: E,
  rows: Row[],
): Promise<Row[] | Awaited<ReturnType<typeof withUniversalEntityMedia>>> {
  if (rows.every((row) => resolvedListMediaSchema.safeParse(row).success)) {
    return rows;
  }
  return withUniversalEntityMedia(db, entityKind, rows, false);
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
  entityKind: Entity,
  rows: readonly Row[],
  // Mappers that parse their row against the list schema take the images as
  // an argument so the parse sees them; the spread below covers the rest.
  toOut: (row: Row, displayImages: DisplayImageSummary[]) => Out,
  // Only the authoritative resolver's result from this read may be reused.
  preloaded?: ReadonlyMap<string, DisplayImageSummary[]>,
): Promise<Array<Out & { displayImages: DisplayImageSummary[] }>> {
  const lists =
    preloaded ??
    (await resolveEntityDisplayImageLists(
      db,
      rows.map((row) => ({ entityKind, entityId: row.id })),
    ));
  return hydrateImageReadProjection(
    db,
    rows.map((row) => {
      const displayImages = lists.get(entityRefKey(entityKind, row.id)) ?? [];
      return { ...toOut(row, displayImages), displayImages };
    }),
    resolvedImageRepresentations(lists),
  );
}
