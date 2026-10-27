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
import type { RawEntityAttachmentRead } from "@cubby/schemas/entity-media-raw-read";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
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

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import type { Database, DrizzleTransaction } from "~/server/db";
import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { mapImages } from "~/server/db/helpers/transform";
import { entityAttachment, image } from "~/server/db/schema";
import { effectiveExpenseProjectSql } from "~/server/domains/expense/repo/expense-inheritance";
import {
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  compatibleSubjectLiftOutputs,
  loadImageRepresentations,
} from "~/server/domains/image-processing/repo/image-processing";
import {
  imageRepresentationRow,
  imageRepresentationRowsSql,
  imageRepresentationsFromRows,
} from "~/server/domains/image-processing/repo/image-representations";
import { displayableImageSql } from "~/server/domains/image/repo/image-displayability";
import { hydrateImageReadProjection } from "~/server/domains/image/repo/image-read-projection";
import { suggestedMerchantVendorCandidatesSql } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { previousShortcodesFor } from "~/server/entity-kernel/repo/entity-identity";
import {
  compileTraversal,
  inheritedRelationSql,
  type InheritedRelation,
} from "~/server/generic/relatedness/repo/traversal";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { withRecordEmoji } from "./entity-emoji";

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
  groups: readonly Readonly<{
    hopIndex: number;
    ordering: "declared" | "newest" | "oldest";
  }>[];
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
  inheritedRelations: readonly InheritedRelation[];
}>;

/** One statement-local relation per inherited field a borrowed path follows. */
const inheritedRelationName = (entity: Entity, field: string) =>
  `display_inherited_${sourceAlias(entity)}_${sourceAlias(field)}`;

/** Each inherited relation the selected branches use, once. */
const inheritedRelationsSql = (branches: readonly DisplayBranch[]): SQL => {
  const relations = new Map(
    branches
      .flatMap((branch) => branch.inheritedRelations)
      .map((relation) => [relation.name, relation]),
  );
  return relations.size
    ? sql`, ${sql.join([...relations.values()].map(inheritedRelationSql), sql`, `)}`
    : sql``;
};

const EXPENSE_PROJECT_RELATION = "display_expense_project";

/** Borrowed media follows declared paths; only direct Image relationships own files. */
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

/**
 * Expand declared fallbacks breadth first: directly related photos precede
 * deeper logos. Each path visits a subject kind once, keeping reciprocal
 * Recipe/Meal and Task/Project declarations finite without runtime recursion.
 */
const DISPLAY_SOURCES: readonly DisplaySource[] = allEntities.flatMap(
  (entity) => {
    const sources: DisplaySource[] = [];
    const pending: Array<{
      target: Entity;
      path: readonly RelationshipPathStep[];
      groups: DisplaySource["groups"];
      visited: ReadonlySet<Entity>;
    }> = [{ target: entity, path: [], groups: [], visited: new Set([entity]) }];
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const parent = pending[cursor]!;
      for (const binding of imageDisplayBindings[parent.target]) {
        const relationship = displayPathSteps(
          parent.target,
          binding.relationPath,
        );
        if (relationship.target !== binding.targetEntity) {
          throw new Error(
            `Image display binding ${parent.target}.${binding.relationPath.join(".")} targets ${binding.targetEntity}, not ${relationship.target}`,
          );
        }
        if (parent.visited.has(relationship.target)) continue;
        const path = [...parent.path, ...relationship.steps];
        const groups = [
          ...parent.groups,
          { hopIndex: path.length - 1, ordering: binding.ordering },
        ];
        if (
          relationship.target === "image" ||
          entityManifest[relationship.target].images.storage !== false
        ) {
          sources.push({
            entity,
            target: relationship.target,
            priority: sources.length + 1,
            groups,
            path:
              relationship.target === "image"
                ? path
                : [...path, ...imageRelationshipSteps(relationship.target)],
          });
        }
        pending.push({
          target: relationship.target,
          path,
          groups,
          visited: new Set([...parent.visited, relationship.target]),
        });
      }
    }
    return sources;
  },
);

/** Keep every relationship group's ordering before its nested groups and files. */
const DISPLAY_GROUP_COUNT = Math.max(
  1,
  ...DISPLAY_SOURCES.map((source) => source.groups.length),
);
const displayGroupColumns = (
  groups: readonly { createdAt: SQL; id: SQL }[],
): SQL =>
  sql.join(
    Array.from({ length: DISPLAY_GROUP_COUNT }, (_, index) => {
      const group = groups[index];
      return sql`${group?.createdAt ?? sql`NULL::timestamptz`} AS ${sql.identifier(`group${index}CreatedAt`)}, ${group?.id ?? sql`NULL::uuid`} AS ${sql.identifier(`group${index}Id`)}`;
    }),
    sql`, `,
  );
const displayGroupOrder = (alias: string): SQL =>
  sql.join(
    Array.from(
      { length: DISPLAY_GROUP_COUNT },
      (_, index) =>
        sql`${sql.identifier(alias)}.${sql.identifier(`group${index}CreatedAt`)}, ${sql.identifier(alias)}.${sql.identifier(`group${index}Id`)}`,
    ),
    sql`, `,
  );

const sourceAlias = (value: string) => value.replaceAll(/[^A-Za-z0-9]/g, "_");

const rootLiveCondition = (entity: Entity, alias: string): SQL =>
  entityManifest[entity].softDelete
    ? sql`${sql.raw(`${alias}."deletedAt"`)} IS NULL`
    : sql`TRUE`;

const aliasColumn = (alias: string, column: string): SQL =>
  sql.raw(`${alias}."${column}"`);

/** Nutrition/package labels are evidence on a Product, never its cover. */
const displayAttachmentCondition = (target: Entity, alias: string): SQL =>
  target === "product"
    ? sql`${aliasColumn(alias, "purpose")} <> 'label'`
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
    ? aliasColumn(attachmentHop!.alias, "sortOrder")
    : sql`0`;
  const createdAt = gallery
    ? aliasColumn(attachmentHop!.alias, "createdAt")
    : aliasColumn("s", "createdAt");
  return sql`
        SELECT i.key, i.shortcode, 0 AS priority,
               ${displayGroupColumns([])},
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
 * Each expanded source ends at a direct attachment. Preserve ordering at every
 * borrowed hop so a deeper fallback retains its parent relationship order.
 */
const displaySourceBranch = (
  source: DisplaySource,
  index: number,
): Pick<
  DisplayBranch,
  "branch" | "usesExpenseProjectRelation" | "inheritedRelations"
> => {
  const traversal = compileTraversal(
    source.entity,
    source.path,
    `display_source_${index}_${sourceAlias(source.entity)}`,
    {
      root: "s",
      leaf: "i",
      expenseProjectRelation: EXPENSE_PROJECT_RELATION,
      inheritedRelation: inheritedRelationName,
    },
  );
  const groups = source.groups.map((group) => {
    const alias = traversal.hops[group.hopIndex]?.alias ?? "s";
    return {
      createdAt:
        group.ordering === "newest"
          ? sql`to_timestamp(-EXTRACT(EPOCH FROM ${aliasColumn(alias, "createdAt")}))`
          : aliasColumn(alias, "createdAt"),
      id: aliasColumn(alias, "id"),
    };
  });
  const groupAlias =
    traversal.hops[source.groups.at(-1)!.hopIndex]?.alias ?? "s";
  const attachmentHop = traversal.hops.at(-2);
  const targetStorage = entityManifest[source.target].images.storage;
  const targetGallery = targetStorage === "gallery";
  if (targetGallery && attachmentHop === undefined) {
    throw new Error(
      `Gallery display source ${source.target} has no attachment hop`,
    );
  }
  const sortOrder = targetGallery
    ? aliasColumn(attachmentHop!.alias, "sortOrder")
    : sql`0`;
  const createdAt = targetGallery
    ? aliasColumn(attachmentHop!.alias, "createdAt")
    : aliasColumn(groupAlias, "createdAt");
  return {
    usesExpenseProjectRelation: traversal.usesExpenseProjectRelation,
    inheritedRelations: traversal.inheritedRelations,
    branch: sql`
        SELECT i.key, i.shortcode, ${source.priority}::integer AS priority,
               ${displayGroupColumns(groups)},
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

const DECLARED_DISPLAY_BRANCHES: readonly DisplayBranch[] = [
  ...allEntities.flatMap((entity) => {
    const branch = directStorageBranch(entity);
    return branch === null
      ? []
      : [
          {
            entity,
            branch,
            usesExpenseProjectRelation: false,
            inheritedRelations: [],
          },
        ];
  }),
  ...DISPLAY_SOURCES.map((source, index) => ({
    entity: source.entity,
    ...displaySourceBranch(source, index),
  })),
];

// Accepted evidence wins; a uniquely supported merchant logo is a later visual fallback.
const DISPLAY_BRANCHES: readonly DisplayBranch[] = [
  ...DECLARED_DISPLAY_BRANCHES,
  ...DECLARED_DISPLAY_BRANCHES.filter(
    ({ entity }) => entity === "financialTransaction",
  ).map((transactionBranch): DisplayBranch => ({
    ...transactionBranch,
    entity: "sourceTransactionRecord",
    branch: sql`
        SELECT media.*
        FROM (${sourceTransactionSettlements}) accepted
        JOIN LATERAL (
          SELECT candidate.*
          FROM (SELECT ${entitySchema.enum.financialTransaction}::text AS "entityKind",
                       accepted."transaction" AS "entityId") refs
          JOIN LATERAL (${transactionBranch.branch}) candidate ON true
        ) media ON true
        WHERE refs."entityKind" = ${entitySchema.enum.sourceTransactionRecord}
          AND accepted."record" = refs."entityId"`,
  })),
  {
    entity: "sourceTransactionRecord",
    usesExpenseProjectRelation: false,
    inheritedRelations: [],
    branch: sql`
      SELECT candidate.key, candidate.shortcode,
             ${DISPLAY_SOURCES.length + 1}::integer AS priority,
             ${displayGroupColumns([])}, candidate."sortOrder", candidate."createdAt", candidate."imageId"
      FROM "SourceTransactionRecord" record
      JOIN source_merchant_vendors merchant
        ON merchant."merchantKey" = btrim(regexp_replace(lower(record.merchant), '\\s+', ' ', 'g'))
      JOIN "Vendor" seller ON seller.shortcode = merchant."vendorShortcode" AND seller."deletedAt" IS NULL
      JOIN LATERAL (
        SELECT ${entitySchema.enum.vendor}::text AS "entityKind", seller.id AS "entityId"
      ) vendor_ref ON true
      JOIN LATERAL (
        SELECT candidate.*
        FROM (SELECT vendor_ref.*) refs
        JOIN LATERAL (${directStorageBranch("vendor")}) candidate ON true
      ) candidate ON true
      WHERE refs."entityKind" = ${entitySchema.enum.sourceTransactionRecord}
        AND record.id = refs."entityId" AND record."deletedAt" IS NULL`,
  },
];

/** One history scan for all source-record merchants requested by this image batch. */
const sourceMerchantImagesSql = (enabled: boolean): SQL => {
  if (!enabled) return sql``;
  const merchantKeys = sql`
    SELECT btrim(regexp_replace(lower(record.merchant), '\\s+', ' ', 'g'))
    FROM "SourceTransactionRecord" record
    JOIN refs ON refs."entityId" = record.id
      AND refs."entityKind" = ${entitySchema.enum.sourceTransactionRecord}
    WHERE record."deletedAt" IS NULL AND record.merchant IS NOT NULL`;
  return sql`, source_merchant_vendors AS MATERIALIZED (
    ${suggestedMerchantVendorCandidatesSql(merchantKeys)}
  )`;
};

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
  const inheritedRelations = inheritedRelationsSql(selected);
  const branches = selected.map(({ branch }) => branch);
  if (entity === "image")
    branches.push(sql`
    SELECT i.key, i.shortcode, 0 AS priority, ${displayGroupColumns([])}, 0 AS "sortOrder", i."createdAt", i.id AS "imageId"
    FROM "Image" i WHERE i.id = refs."entityId" AND i."deletedAt" IS NULL
      AND ${displayableImageSql("i")}`);
  if (branches.length === 0) return sql`false`;
  return sql`EXISTS (
    WITH refs AS (SELECT ${entity}::text AS "entityKind", ${id} AS "entityId")
    ${expenseRelation}
    ${sourceMerchantImagesSql(entity === "sourceTransactionRecord")}
    ${inheritedRelations}
    SELECT 1 FROM refs JOIN LATERAL (
      ${sql.join(branches, sql` UNION ALL `)}
    ) candidates ON true
  )`;
};

const displayImageRowSchema = z.object({
  entityKind: entitySchema,
  entityId: z.string(),
  refKey: z.string(),
  representations: z.array(imageRepresentationRow).optional(),
  images: z.array(
    z.object({
      id: imageShortcode,
      key: z.string(),
      useOriginal: z.boolean(),
      derivativeKey: z.string().nullable(),
      priority: z.number(),
      sourceId: z.string().nullable(),
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
 * mechanically for every image-owning entity.
 * Direct storage always wins. Explicit relationship arms then supply truthful
 * fallback imagery through finite, cycle-guarded paths. All candidates are
 * selected in this one query rather than recursively loading related records.
 * Callers keep UUIDs private, map the returned summaries onto public DTOs, and
 * use a semantic entity mark when a ref resolves to nothing.
 */
async function resolveDisplayImageListsFromSqlRefs(
  db: Database | DrizzleTransaction,
  refsSql: SQL,
  sourceTypes: ReadonlySet<Entity>,
): Promise<Map<string, DisplayImageSummary[]>> {
  const { ranked } = await resolveRankedDisplayImages(db, refsSql, sourceTypes);
  return new Map(
    [...ranked].map(([key, images]) => [key, images.map(({ image }) => image)]),
  );
}

/** One displayable image with its precedence level and the record it comes from. */
export interface RankedDisplayImage {
  readonly image: DisplayImageSummary;
  /** 0 for the record's own images; borrowed sources follow in declared order. */
  readonly priority: number;
  /** The record the image is attached to, when borrowed; null for its own. */
  readonly sourceId: string | null;
}

/** The display-image chain of one record (ADR 0021 image explanation). */
export async function resolveEntityDisplayImageChain(
  db: Database | DrizzleTransaction,
  ref: EntityDisplayImageRef,
): Promise<RankedDisplayImage[]> {
  if (!DISPLAY_IMAGE_ENTITIES.has(ref.entityKind)) return [];
  const key = entityRefKey(ref.entityKind, ref.entityId);
  const { ranked } = await resolveRankedDisplayImages(
    db,
    sql`refs("entityKind", "entityId", "refKey") AS (VALUES (${ref.entityKind}::text, ${ref.entityId}::uuid, ${key}::text))`,
    new Set([ref.entityKind]),
  );
  return ranked.get(key) ?? [];
}

/** Public refs of the records a chain borrows from, keyed by internal id. */
export async function loadDisplayImageSources(
  db: Database | DrizzleTransaction,
  chain: readonly RankedDisplayImage[],
): Promise<Map<string, PublicEntityRef>> {
  const ids = [
    ...new Set(chain.flatMap(({ sourceId }) => (sourceId ? [sourceId] : []))),
  ];
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({
      id: entityIdentity.id,
      kind: entityIdentity.kind,
      shortcode: entityIdentity.shortcode,
    })
    .from(entityIdentity)
    .where(inArray(entityIdentity.id, ids));
  return new Map(
    rows.map((row) => [
      row.id,
      { entityKind: row.kind, entityId: row.shortcode ?? row.id },
    ]),
  );
}

async function resolveRankedDisplayImages(
  db: Database | DrizzleTransaction,
  refsSql: SQL,
  sourceTypes: ReadonlySet<Entity>,
  includeAttachments = false,
): Promise<{
  ranked: Map<string, RankedDisplayImage[]>;
  representations: Map<string, ImageRepresentations>;
}> {
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
    ${sourceMerchantImagesSql(sourceTypes.has("sourceTransactionRecord"))}
    ${inheritedRelationsSql(selectedBranches)}
    SELECT refs."entityKind", refs."entityId"::text AS "entityId", refs."refKey", (
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', candidates.shortcode,
            'key', candidates.key,
            'useOriginal', selected_image."useOriginal",
            'derivativeKey', derivative.key,
            'priority', candidates.priority,
            'sourceId', candidates."group0Id"
          )
          ORDER BY candidates.priority, ${displayGroupOrder("candidates")},
                   candidates."sortOrder", candidates."createdAt", candidates."imageId"
        ),
        '[]'::json
      )
      FROM (
        SELECT DISTINCT ON (raw_candidates."imageId") raw_candidates.*
        FROM (
        SELECT i.key, i.shortcode, 0 AS priority, ${displayGroupColumns([])}, 0 AS "sortOrder", i."createdAt", i.id AS "imageId"
        FROM "Image" i
        WHERE refs."entityKind" = 'image' AND i.id = refs."entityId"
          AND i."deletedAt" IS NULL AND ${displayableImageSql("i")}
        ${borrowedImages}
        ) raw_candidates
        ORDER BY raw_candidates."imageId", raw_candidates.priority,
                 ${displayGroupOrder("raw_candidates")},
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
    ) AS images ${
      includeAttachments
        ? sql`, (
      SELECT COALESCE(json_agg(attachment), '[]'::json)
      FROM (${imageRepresentationRowsSql({ attachedTo: sql`refs."entityId"` }, compatibleSubjectLiftOutputs)}) attachment
    ) AS representations`
        : sql``
    }
    FROM refs
  `);

  const rows = z.array(displayImageRowSchema).parse(result.rows);
  const ranked = new Map(
    rows.map((row) => [
      row.refKey,
      row.images.map((img) => {
        const original = getR2PublicUrl(img.key);
        const transparent = img.derivativeKey
          ? getR2PublicUrl(img.derivativeKey)
          : null;
        const preferTransparent = !img.useOriginal && transparent !== null;
        return {
          priority: img.priority,
          sourceId: img.sourceId === row.entityId ? null : img.sourceId,
          image: {
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
          },
        };
      }),
    ]),
  );
  return {
    ranked,
    representations: imageRepresentationsFromRows(
      rows.flatMap((row) => row.representations ?? []),
    ),
  };
}

export interface EntityDisplayMedia {
  readonly displayImages: ReadonlyMap<string, DisplayImageSummary[]>;
  readonly representations: ReadonlyMap<string, ImageRepresentations>;
}

/** Resolve canonical display images and requested attachment representations in one query. */
export async function resolveEntityDisplayMedia(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
  options: { attachments?: boolean } = {},
): Promise<EntityDisplayMedia> {
  const supported = [
    ...new Map(
      refs
        .filter((ref) => DISPLAY_IMAGE_ENTITIES.has(ref.entityKind))
        .map((ref) => [entityRefKey(ref.entityKind, ref.entityId), ref]),
    ).values(),
  ];
  if (supported.length === 0)
    return { displayImages: new Map(), representations: new Map() };
  const values = sql.join(
    supported.map(
      (ref) =>
        sql`(${ref.entityKind}::text, ${ref.entityId}::uuid, ${entityRefKey(ref.entityKind, ref.entityId)}::text)`,
    ),
    sql`, `,
  );
  const resolved = await resolveRankedDisplayImages(
    db,
    sql`refs("entityKind", "entityId", "refKey") AS (VALUES ${values})`,
    new Set(supported.map((ref) => ref.entityKind)),
    options.attachments === true,
  );
  return {
    displayImages: new Map(
      [...resolved.ranked].map(([key, images]) => [
        key,
        images.map(({ image }) => image),
      ]),
    ),
    representations: resolved.representations,
  };
}

/** Public shortcodes join durable identities inside the image query. */
export async function resolvePublicEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly PublicEntityRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
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
  return resolveDisplayImageListsFromSqlRefs(
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
}

/** The cover of each public ref, for surfaces that show one thumbnail. */
export async function resolvePublicEntityDisplayImages(
  db: Database | DrizzleTransaction,
  refs: readonly PublicEntityRef[],
): Promise<Map<string, ImageUrlSummary>> {
  const lists = await resolvePublicEntityDisplayImageLists(db, refs);
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
  return new Map((await resolveEntityDisplayMedia(db, refs)).displayImages);
}

const publicEntityRowSchema = z.looseObject({
  id: z.string(),
  fieldResolutions: fieldResolutionsSchema.nullish(),
});
const resolvedListMediaSchema = z.object({ displayImages: displayImagesField });
type PublicEntityRow = z.output<typeof publicEntityRowSchema>;

/** Reuse only the authoritative media resolved for this read batch. */
const resolvedImageRepresentations = (
  lists: ReadonlyMap<string, readonly DisplayImageSummary[]>,
  attachments?: ReadonlyMap<string, readonly RawEntityAttachmentRead[]>,
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
): Promise<Map<string, RawEntityAttachmentRead[]>> => {
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
  const attachments = new Map<string, RawEntityAttachmentRead[]>();
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
): Promise<Map<string, RawEntityAttachmentRead[]>> =>
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
      attachments?: RawEntityAttachmentRead[];
      redirectedFrom?: string | null;
      previousShortcodes?: string[];
    }
  >
> {
  const parsed = rows.map((row) => publicEntityRowSchema.parse(row));
  // Independent reads: the emoji and the shortcode resolution share a round trip.
  const [publicRows, resolved] = await Promise.all([
    withRecordEmoji(db, entityKind, parsed),
    resolveLiveShortcodes(
      db,
      parsed.map((row) => row.id),
      entityKind,
    ),
  ]);
  const refs = publicRows.flatMap((row) => {
    const entityId = resolved.get(row.id);
    return entityId === undefined ? [] : [{ entityKind, entityId }];
  });
  const entityIds = refs.map((ref) => ref.entityId);
  const [lists, attachments, previousShortcodes] = await Promise.all([
    resolveEntityDisplayImageLists(db, refs),
    detail
      ? resolveEntityAttachments(db, entityKind, entityIds)
      : Promise.resolve(new Map<string, RawEntityAttachmentRead[]>()),
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
    return withRecordEmoji(db, entityKind, rows);
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
  preloaded?: EntityDisplayMedia,
): Promise<Array<Out & { displayImages: DisplayImageSummary[] }>> {
  const lists =
    preloaded?.displayImages ??
    (await resolveEntityDisplayImageLists(
      db,
      rows.map((row) => ({ entityKind, entityId: row.id })),
    ));
  const representations = new Map(preloaded?.representations);
  // Preserve the display resolver's precedence for images it already resolved.
  // Extra attachment representations cover only references missing from that set.
  for (const [code, value] of resolvedImageRepresentations(lists))
    representations.set(code, value);
  return hydrateImageReadProjection(
    db,
    rows.map((row) => {
      const displayImages = lists.get(entityRefKey(entityKind, row.id)) ?? [];
      return { ...toOut(row, displayImages), displayImages };
    }),
    representations,
  );
}
