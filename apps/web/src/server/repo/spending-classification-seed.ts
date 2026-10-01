import { createHash } from "node:crypto";

import {
  parseEntityId,
  parseShortcodeFor,
  spendingCategoryShortcode,
  spendingCategoryId,
  productCategoryId,
  productCategoryShortcode,
  userId,
} from "@cubby/schemas/identifiers";
import {
  SHORTCODE_CHARS,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_PREFIX,
} from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";

import { unwrapDb, withTransactionDatabase } from "./database-helpers";
import {
  spendingClassificationRevision,
  type ExpenseSpendingCategoryResolutionDraft,
} from "./expense-category-resolution";
import { loadExpenseJointAllocations } from "./expense-project-allocation";
import { applyReviewedSpendingClassificationPolicy } from "./spending-classification-review";
import { withReviewedSpendingClassification } from "./spending-classification-review-authorization";

const label = z.string().trim().min(1);
export const spendingClassificationSeedManifest = z.object({
  categories: z.array(
    z.object({
      key: label,
      name: label,
      aliases: z.array(label),
      parentKey: label.nullable(),
    }),
  ),
  mappings: z.array(
    z.object({ productCategoryName: label, categoryKey: label }),
  ),
});
export type SpendingClassificationSeedManifest = z.infer<
  typeof spendingClassificationSeedManifest
>;
const categoryRow = z.object({
  id: spendingCategoryShortcode,
  uuid: spendingCategoryId,
  name: z.string(),
  aliases: z.array(z.string()),
  parentId: spendingCategoryShortcode.nullable(),
  parentUuid: z.string().nullable(),
});
const taxonomyRow = z.object({
  id: productCategoryShortcode,
  uuid: productCategoryId,
  name: z.string(),
  mode: z.enum(["inherit", "mapped", "blocked"]),
  categoryId: spendingCategoryShortcode.nullable(),
});
const normalized = (value: string) => value.trim().toLowerCase();
const fail = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(z.json().parse(value)))
    .digest("hex");

function virtualCategoryCode(index: number) {
  let remaining = index;
  let body = "";
  do {
    body = SHORTCODE_CHARS[remaining % SHORTCODE_CHARS.length]! + body;
    remaining = Math.floor(remaining / SHORTCODE_CHARS.length);
  } while (remaining > 0);
  if (body.length > SHORTCODE_BODY_LENGTH)
    fail("Seed preview exceeds the virtual identity space.");
  return parseShortcodeFor(
    "spendingCategory",
    SHORTCODE_PREFIX.spendingCategory +
      body.padStart(SHORTCODE_BODY_LENGTH, SHORTCODE_CHARS[0]!),
  );
}

function orderedCategories(manifest: SpendingClassificationSeedManifest) {
  const byKey = new Map(
    manifest.categories.map((category) => [category.key, category]),
  );
  if (byKey.size !== manifest.categories.length)
    fail("Seed category keys are ambiguous.");
  const labels = new Map<string, string>();
  for (const category of manifest.categories)
    for (const name of [category.name, ...category.aliases]) {
      const key = normalized(name);
      if (labels.has(key) && labels.get(key) !== category.key)
        fail("Seed alias is ambiguous across curated categories.");
      labels.set(key, category.key);
    }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: typeof manifest.categories = [];
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) fail("Seed category hierarchy contains a cycle.");
    const category = byKey.get(key);
    if (!category)
      return fail("Seed category parent or mapping target is missing.");
    visiting.add(key);
    if (category.parentKey) visit(category.parentKey);
    visiting.delete(key);
    visited.add(key);
    ordered.push(category);
  };
  for (const category of manifest.categories) visit(category.key);
  for (const mapping of manifest.mappings)
    if (!byKey.has(mapping.categoryKey))
      fail("Seed mapping category target is missing.");
  return ordered;
}

/** Exact approved labels only; neither fuzzy matching nor alias consolidation is permitted. */
async function buildSeedPreview(
  db: Database,
  raw: SpendingClassificationSeedManifest,
) {
  const manifest = spendingClassificationSeedManifest.parse(raw);
  const seeds = orderedCategories(manifest);
  const existing = z.array(categoryRow).parse(
    (
      await unwrapDb(db).execute(sql`
    SELECT c.shortcode AS id,c.id AS uuid,c.name,c.aliases,parent.shortcode AS "parentId",c."parentId" AS "parentUuid"
    FROM "SpendingCategory" c LEFT JOIN "SpendingCategory" parent ON parent.id=c."parentId" AND parent."deletedAt" IS NULL
    WHERE c."deletedAt" IS NULL ORDER BY c.shortcode
  `)
    ).rows,
  );
  const taxonomy = z.array(taxonomyRow).parse(
    (
      await unwrapDb(db).execute(sql`
    SELECT c.shortcode AS id,c.id AS uuid,c.name,c."spendingCategoryMode" AS mode,s.shortcode AS "categoryId"
    FROM "ProductCategory" c LEFT JOIN "SpendingCategory" s ON s.id=c."spendingCategoryId" AND s."deletedAt" IS NULL
    WHERE c."deletedAt" IS NULL ORDER BY c.shortcode
  `)
    ).rows,
  );
  const used = new Set<string>();
  const categories = seeds.map((seed) => {
    const keys = new Set([seed.name, ...seed.aliases].map(normalized));
    const matches = existing.filter((row) =>
      [row.name, ...row.aliases].some((name) => keys.has(normalized(name))),
    );
    if (matches.length > 1)
      fail(`Seed category or alias is ambiguous: ${seed.name}`);
    const row = matches[0] ?? null;
    if (row && used.has(row.id))
      fail(
        "Seed aliases resolve multiple curated categories to one existing category.",
      );
    if (row) used.add(row.id);
    const aliases = [...(row?.aliases ?? [])];
    const additional =
      row && normalized(row.name) !== normalized(seed.name)
        ? [seed.name, ...seed.aliases]
        : seed.aliases;
    for (const alias of additional)
      if (!aliases.some((value) => normalized(value) === normalized(alias)))
        aliases.push(alias);
    return { ...seed, existing: row, aliases };
  });
  const finalLabels = new Map<string, string>();
  for (const category of categories) {
    for (const name of [
      category.existing?.name ?? category.name,
      ...category.aliases,
    ]) {
      const key = normalized(name);
      if (finalLabels.has(key) && finalLabels.get(key) !== category.key)
        fail("Seed inherited alias is ambiguous across planned categories.");
      finalLabels.set(key, category.key);
      if (
        existing.some(
          (row) =>
            row.id !== category.existing?.id &&
            [row.name, ...row.aliases].some(
              (value) => normalized(value) === key,
            ),
        )
      )
        fail(
          "Seed inherited or appended alias is ambiguous with another live category.",
        );
    }
  }
  for (const category of categories) {
    const parent = categories.find((row) => row.key === category.parentKey);
    if (
      category.existing?.parentUuid &&
      category.existing.parentId !== parent?.existing?.id
    )
      fail(
        "Existing seed category has a different explicit parent; review that hierarchy separately.",
      );
  }
  const mapped = new Set<string>();
  const mappings = manifest.mappings.map((mapping) => {
    const matches = taxonomy.filter(
      (row) => normalized(row.name) === normalized(mapping.productCategoryName),
    );
    if (!matches.length)
      return fail(
        `Missing exact taxonomy identity: ${mapping.productCategoryName}`,
      );
    if (matches.length > 1)
      return fail(
        `Ambiguous exact taxonomy identity: ${mapping.productCategoryName}`,
      );
    const source = matches[0]!;
    if (mapped.has(source.id))
      fail("Seed contains duplicate ProductCategory mapping identities.");
    mapped.add(source.id);
    return {
      ...mapping,
      source,
      preserve: source.mode !== "inherit" || source.categoryId !== null,
    };
  });
  const policyRevision = await spendingClassificationRevision(db);
  const virtual = categories
    .filter((category) => !category.existing)
    .map((category, index) => {
      const hash = digest({
        version: 1,
        namespace: "spending-classification-seed-preview",
        key: category.key,
      });
      const id = parseEntityId(
        "spendingCategory",
        `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      );
      const shortcode = virtualCategoryCode(index);
      if (existing.some((row) => row.uuid === id || row.id === shortcode))
        fail("Virtual preview identity collides with the existing catalog.");
      return { key: category.key, id, shortcode, name: category.name };
    });
  const targetId = (key: string) => {
    const existingTarget = categories.find(
      (category) => category.key === key,
    )?.existing;
    return existingTarget
      ? existingTarget.uuid
      : virtual.find((category) => category.key === key)!.id;
  };
  const draft: ExpenseSpendingCategoryResolutionDraft = {
    categories: virtual,
    productCategories: mappings
      .filter((mapping) => !mapping.preserve)
      .map((mapping) => ({
        id: mapping.source.uuid,
        spendingCategoryMode: "mapped",
        spendingCategoryId: targetId(mapping.categoryKey),
      })),
  };
  const before = await loadExpenseJointAllocations(db);
  const after = await loadExpenseJointAllocations(db, undefined, draft);
  const allocations = (rows: typeof before) =>
    rows
      .map((row) => ({
        ...row,
        sourceCents: row.sourceCents?.toString() ?? null,
        attributedCents: row.attributedCents?.toString() ?? null,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const history = (
    await unwrapDb(db)
      .execute(sql`SELECT jsonb_build_object('expense',to_jsonb(e),'product',to_jsonb(g),'purchase',to_jsonb(p)) AS facts
    FROM "Expense" e LEFT JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL
    LEFT JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL ORDER BY e.id`)
  ).rows;
  const centsFor = (rows: typeof before, id: string | null) =>
    rows
      .filter((row) => row.spendingCategoryId === id)
      .reduce((sum, row) => sum + (row.attributedCents ?? 0n), 0n);
  const categoryIds = new Set([
    ...categories.map((category) => targetId(category.key)),
    ...before.map((row) => row.spendingCategoryId),
    ...after.map((row) => row.spendingCategoryId),
    null,
  ]);
  const categoryDeltas = [...categoryIds].map((id) => {
    const category = categories.find((row) => targetId(row.key) === id);
    const allocation = [...before, ...after].find(
      (row) => row.spendingCategoryId === id,
    );
    const beforeCents = centsFor(before, id);
    const afterCents = centsFor(after, id);
    return {
      categoryKey: category?.key ?? null,
      spendingCategoryId:
        category && !category.existing
          ? null
          : (allocation?.spendingCategoryShortcode ??
            category?.existing?.id ??
            null),
      name: category?.name ?? allocation?.spendingCategoryName ?? null,
      beforeCents: beforeCents.toString(),
      afterCents: afterCents.toString(),
      deltaCents: (afterCents - beforeCents).toString(),
    };
  });
  return {
    categories,
    mappings,
    policyRevision,
    categoryDeltas,
    newCategories: categories.filter((row) => !row.existing).length,
    plannedMappings: mappings.filter((row) => !row.preserve).length,
    preservedMappings: mappings.filter((row) => row.preserve).length,
    fingerprint: digest({
      version: 1,
      manifest,
      existing,
      taxonomy,
      policyRevision,
      history,
      before: allocations(before),
      after: allocations(after),
    }),
  };
}

export async function previewSpendingClassificationSeed(
  db: Database,
  manifest: SpendingClassificationSeedManifest,
) {
  return withTransactionDatabase(
    db,
    (snapshot) => buildSeedPreview(snapshot, manifest),
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );
}

/** Fingerprint check, audited taxonomy writes and reviewed policy writes share one transaction. */
export async function applySpendingClassificationSeed(
  ctx: EntityKernelContext,
  manifest: SpendingClassificationSeedManifest,
  fingerprint: string,
) {
  return withTransactionDatabase(
    ctx.db,
    async (db) => {
      const preview = await buildSeedPreview(db, manifest);
      if (preview.fingerprint !== fingerprint)
        fail(
          "Seed policy, taxonomy or history changed; review a fresh preview before applying.",
        );
      const context = { ...ctx, db };
      const targets = new Map<
        string,
        z.infer<typeof spendingCategoryShortcode>
      >();
      let createdCategories = 0;
      let updatedCategories = 0;
      for (const category of preview.categories) {
        const parentId = category.parentKey
          ? targets.get(category.parentKey)
          : null;
        if (category.parentKey && !parentId)
          fail("Reviewed seed parent is missing.");
        if (!category.existing) {
          const created = await executeEntity(context, {
            action: "create",
            entity: "spendingCategory",
            data: {
              name: category.name,
              aliases: category.aliases,
              parentId: parentId ?? null,
              evidenceExpectation: "unknown",
              productExpectation: "unknown",
            },
          });
          targets.set(category.key, created.item.id);
          createdCategories++;
        } else {
          targets.set(category.key, category.existing.id);
          if (
            JSON.stringify(category.aliases) !==
              JSON.stringify(category.existing.aliases) ||
            category.existing.parentId !== (parentId ?? null)
          ) {
            await executeEntity(context, {
              action: "update",
              entity: "spendingCategory",
              id: category.existing.id,
              data: { aliases: category.aliases, parentId: parentId ?? null },
            });
            updatedCategories++;
          }
        }
      }
      let updatedMappings = 0;
      await withReviewedSpendingClassification(db, async () => {
        for (const mapping of preview.mappings) {
          if (mapping.preserve) continue;
          const target = targets.get(mapping.categoryKey);
          if (!target) return fail("Reviewed seed mapping target is missing.");
          await applyReviewedSpendingClassificationPolicy(context, {
            action: "productCategory",
            productCategoryId: mapping.source.id,
            spendingCategoryMode: "mapped",
            spendingCategoryId: target,
          });
          updatedMappings++;
        }
      });
      return {
        createdCategories,
        updatedCategories,
        updatedMappings,
        preservedMappings: preview.preservedMappings,
      };
    },
    { isolationLevel: "serializable" },
  );
}

/** The initiating login must already belong to exactly one live named member. */
export async function resolveSpendingClassificationSeedActor(
  db: Database,
  name: string,
) {
  const rows = z.array(z.object({ id: userId })).parse(
    (
      await unwrapDb(db).execute(sql`
    SELECT u.id FROM "LedgerParty" p JOIN "user" u ON u.id=p."userId"
    WHERE p.kind='member' AND p."deletedAt" IS NULL AND p.name=${label.parse(name)}
  `)
    ).rows,
  );
  if (rows.length !== 1)
    fail("Seed actor name must resolve to exactly one existing member login.");
  return rows[0]!.id;
}
