import type { Entity } from "@cubby/schemas/entity";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { imageListFiltersSchema } from "@cubby/schemas/image";
import { ingredientFiltersSchema } from "@cubby/schemas/ingredient";
import { inventoryFiltersSchema } from "@cubby/schemas/inventory";
import { locationFiltersSchema } from "@cubby/schemas/location";
import { mealFiltersSchema } from "@cubby/schemas/meal";
import { problemDetectors, type ProblemKey } from "@cubby/schemas/problems";
import { productFiltersSchema } from "@cubby/schemas/product";
import {
  projectFiltersSchema,
  taskFiltersSchema,
  type ProjectAttentionItem,
} from "@cubby/schemas/project";
import { recipeFiltersSchema } from "@cubby/schemas/recipe";
import { vendorFiltersSchema } from "@cubby/schemas/vendor";
import {
  workQueueGapChecks,
  workQueueGapViews,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { type ParsedShortcode } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { sql, type SQL } from "drizzle-orm";
import { getTableName } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import type {
  EntityProblemSource,
  FilterAssembly,
} from "~/entity/problems/problem-query";
import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import type { Database } from "~/server/db";
import { buildImageWhere } from "~/server/domains/image/repo/image";
import { buildIngredientListWhere } from "~/server/domains/ingredient/repo/search";
import { buildInventoryWhere } from "~/server/domains/inventory/repo/crud";
import { buildLocationWhere } from "~/server/domains/location/repo/crud";
import { buildMealWhere } from "~/server/domains/meal/repo/crud";
import { buildProductWhere } from "~/server/domains/product/repo/crud";
import { computeAttentionItems } from "~/server/domains/project/repo/attention";
import { buildProjectWhere } from "~/server/domains/project/repo/lookup";
import { buildRecipeWhere } from "~/server/domains/recipe/repo/crud";
import { statementImportMembers } from "~/server/domains/statement-import/repo/statement-import-membership";
import { buildTaskWhere } from "~/server/domains/task/repo/lookup";
import { buildVendorWhereClause } from "~/server/domains/vendor/repo/vendor";
import { labelSql } from "~/server/generic/entity-graph/repo/entity-graph";
import { findIncompleteStatementImports } from "~/server/generic/problems/repo/detectors-financial";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";
import {
  scopeAdmitsUnrecorded,
  workDiagnosticCandidate,
  workQueueCandidate,
  type WorkQueueScope,
} from "~/server/generic/work-queue/repo/work-queue-projection";
import {
  workExpenseOwners,
  workImageOwners,
  workImageIsShared,
  workPurchaseOwners,
  workRunOwners,
} from "~/server/generic/work-queue/repo/work-queue-routing";

type WhereBuilder = (
  db: Database,
  filters: FilterAssembly,
  attentionItems?: readonly ProjectAttentionItem[],
) => SQL | undefined | Promise<SQL | undefined>;
const sharedProblemBuilders = {
  product: (db, filters) =>
    buildProductWhere(
      db,
      productFiltersSchema.parse(compileProblemFilters("product", filters)),
    ),
  ingredient: (db, filters) =>
    buildIngredientListWhere(
      db,
      ingredientFiltersSchema.parse(
        compileProblemFilters("ingredient", filters),
      ),
    ),
  recipe: (db, filters) =>
    buildRecipeWhere(
      db,
      recipeFiltersSchema.parse(compileProblemFilters("recipe", filters)),
    ),
  inventory: (db, filters) =>
    buildInventoryWhere(
      db,
      inventoryFiltersSchema.parse(compileProblemFilters("inventory", filters)),
    ),
  location: (db, filters) =>
    buildLocationWhere(
      db,
      locationFiltersSchema.parse(compileProblemFilters("location", filters)),
    ),
  meal: (db, filters) =>
    buildMealWhere(
      db,
      mealFiltersSchema.parse(compileProblemFilters("meal", filters)),
    ),
  project: (db, filters, attentionItems) =>
    buildProjectWhere(
      db,
      projectFiltersSchema.parse(compileProblemFilters("project", filters)),
      attentionItems,
    ),
  task: (db, filters) =>
    buildTaskWhere(
      db,
      taskFiltersSchema.parse(compileProblemFilters("task", filters)),
    ),
  vendor: (_db, filters) =>
    buildVendorWhereClause(
      vendorFiltersSchema.parse(compileProblemFilters("vendor", filters)),
    ),
  image: (db, filters) =>
    buildImageWhere(
      db,
      imageListFiltersSchema.parse(compileProblemFilters("image", filters)),
    ),
} satisfies Partial<Record<Entity, WhereBuilder>>;

/** Only automatic maintenance or external inference is outside the interactive queue. */
const excludedDiagnostics = new Set([
  "import-findings", // The queue owns the read-only open/unexpired relation.
  "provisional-financial-accounts", // Uses its canonical gap SQL in the queue.
  "entities-missing-embeddings",
  "products-with-better-upc-data",
  "stale-parent-recipes",
  "referential-liveness-violations",
  "incomplete-statement-imports", // Reviewed through current accounts below.
]);
const hasPublicRecord = (entity: Entity): entity is ShortcodeEntity =>
  shortcodeEntities.some((kind) => kind === entity);

/** Diagnostic schemas validate every value before public references enter the queue. */
const privateDiagnosticKeys = new Set([
  "duplicateFinancialTransactionSourceRefs",
  "duplicateFinancialAccountSourceAliases",
  "invalidFinancialJson",
  "duplicateSpendCandidates",
]);
const privateProblemEntry = (
  key: ProblemKey,
  item: unknown,
): Pick<WorkQueueRow, "reason"> & {
  refs: ParsedShortcode[];
  fingerprintPayload: string;
} => {
  switch (key) {
    case "duplicateFinancialTransactionSourceRefs": {
      const parsed =
        problemDetectors.duplicateFinancialTransactionSourceRefs.item.parse(
          item,
        );
      return {
        refs: parsed.transactionIds.map((shortcode) => ({
          type: "financialTransaction",
          shortcode,
        })),
        fingerprintPayload: JSON.stringify({
          ...parsed,
          transactionIds: [...parsed.transactionIds].sort(),
        }),
        reason: `Repeated settlement reference from ${parsed.source}: ${parsed.externalId}.`,
      };
    }
    case "duplicateFinancialAccountSourceAliases": {
      const parsed =
        problemDetectors.duplicateFinancialAccountSourceAliases.item.parse(
          item,
        );
      return {
        refs: parsed.accountIds.map((shortcode) => ({
          type: "financialAccount",
          shortcode,
        })),
        fingerprintPayload: JSON.stringify({
          ...parsed,
          accountIds: [...parsed.accountIds].sort(),
        }),
        reason: `Repeated account identity from ${parsed.source}: ${parsed.externalAccountId}.`,
      };
    }
    case "invalidFinancialJson": {
      const parsed = problemDetectors.invalidFinancialJson.item.parse(item);
      return {
        refs:
          parsed.entity === "financialAccount"
            ? [{ type: parsed.entity, shortcode: parsed.id }]
            : [{ type: parsed.entity, shortcode: parsed.id }],
        fingerprintPayload: JSON.stringify(parsed),
        reason: `${parsed.field}: ${parsed.message}`,
      };
    }
    case "duplicateSpendCandidates": {
      const parsed = problemDetectors.duplicateSpendCandidates.item.parse(item);
      return {
        refs: [
          { type: "expense", shortcode: parsed.id },
          { type: "purchase", shortcode: parsed.purchaseId },
        ],
        fingerprintPayload: JSON.stringify(parsed),
        reason: `Possible duplicate expense ${parsed.id} and purchase ${parsed.purchaseId} (${parsed.matchedOn}).`,
      };
    }
    default:
      throw new Error(
        `Private Work diagnostic ${key} has no declared references`,
      );
  }
};

const privateOwnerRelation = (ref: ParsedShortcode): SQL | null => {
  const table = SHORTCODE_TABLE[ref.type];
  const id = sql`${table.id}`;
  const scope = sql`${table.shortcode} = ${ref.shortcode} AND ${table.deletedAt} IS NULL`;
  let owners: SQL;
  switch (ref.type) {
    case "purchase":
      owners = workPurchaseOwners(id);
      break;
    case "expense":
      owners = workExpenseOwners(id);
      break;
    case "run":
      owners = workRunOwners(id);
      break;
    case "financialAccount":
      owners = sql`ARRAY["FinancialAccount"."ledgerPartyId"]`;
      break;
    case "financialTransaction":
      owners = sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND account."deletedAt" IS NULL)`;
      break;
    case "vendorAccount":
      owners = sql`ARRAY["VendorAccount"."ledgerPartyId"]`;
      break;
    case "email":
      owners = sql`ARRAY["Email"."ledgerPartyId"]`;
      break;
    default:
      return null;
  }
  // A missing private record or owner poisons the group, rather than making it shared.
  return sql`coalesce((SELECT CASE WHEN cardinality(authority.owners) > 0 THEN authority.owners ELSE ARRAY[NULL::uuid] END FROM ${table} CROSS JOIN LATERAL (SELECT ${owners} AS owners) authority WHERE ${scope}), ARRAY[NULL::uuid])`;
};

const includesWorkSource = (
  scope: WorkQueueScope,
  source: WorkQueueScope["source"],
  kind: WorkQueueScope["kind"],
) =>
  (!scope.source || scope.source === source) &&
  (!scope.kind || scope.kind === kind);
const needsProjectAttention = (source: EntityProblemSource) =>
  source.entity === "project" &&
  source.filters.some((filter) => filter.id === "attention");

const sharedProblemScope = (entity: ShortcodeEntity, id: SQL) =>
  entity === "image"
    ? { owners: workImageOwners(id), shared: workImageIsShared(id) }
    : { owners: sql`ARRAY[]::uuid[]`, shared: true };

export async function additionalWorkProblemSelections(
  db: Database,
  scope: WorkQueueScope,
): Promise<SQL[]> {
  const selections: SQL[] = [];
  const includeProblems = includesWorkSource(scope, "problem", "repair");
  // Diagnostics and statement imports name no single record and carry no gaps.
  const includeUnrecorded = scopeAdmitsUnrecorded(scope);
  const includeAccounts =
    includeUnrecorded && includesWorkSource(scope, "account", "review");
  if (scope.check || (!includeProblems && !includeAccounts)) return selections;
  let attentionPromise: Promise<ProjectAttentionItem[]> | undefined;
  // A Project record read evaluates the shared attention rules for that
  // project only; non-project record reads never reach the project branch.
  const scopedProjects = async () => {
    if (scope.record?.entity !== "project") return undefined;
    const ids = await resolveLiveShortcodes(db, [scope.record.id], "project");
    return [...ids.values()];
  };
  const attentionItems = () =>
    (attentionPromise ??= scopedProjects().then((projectIds) =>
      computeAttentionItems(db, projectIds ? { projectIds } : undefined),
    ));
  for (const definition of problemQueryDeclarations()) {
    if (!includeProblems) break;
    const source = definition.source;
    const details = {
      source: "problem",
      kind: "repair",
      reason: definition.title,
      nextAction: definition.description,
    } as const;
    if (source.kind === "entity") {
      const gapView = workQueueGapViews.find(
        (view) => view.entity === source.entity,
      );
      const coveredChecks = new Set<string>(
        gapView ? workQueueGapChecks(gapView) : [],
      );
      // Canonical gap views already emit this work with structured checks.
      if (
        source.filters.length > 0 &&
        source.filters.every(
          (filter) =>
            filter.id === "dataGaps" &&
            (Array.isArray(filter.value) ? filter.value : [filter.value]).every(
              (check) => coveredChecks.has(check),
            ),
        )
      )
        continue;
      if (
        ["purchase", "expense", "financialTransaction"].includes(
          source.entity,
        ) ||
        (scope.record && scope.record.entity !== source.entity)
      )
        continue;
      const buildWhere = Object.entries(sharedProblemBuilders).find(
        ([entity]) => entity === source.entity,
      )?.[1];
      if (!buildWhere)
        throw new Error(
          `Interactive Work has no canonical reader for ${source.entity}`,
        );
      if (!hasPublicRecord(source.entity))
        throw new Error(
          `Interactive Work requires a public record for ${source.entity}`,
        );
      const table = SHORTCODE_TABLE[source.entity];
      const from =
        source.entity === "inventory"
          ? sql`${table} INNER JOIN "Product" ON "Product".id = "InventoryEntry"."productId" INNER JOIN "Location" ON "Location".id = "InventoryEntry"."locationId"`
          : sql`${table}`;
      const routing = sharedProblemScope(source.entity, sql`${table.id}`);
      selections.push(
        ...workQueueCandidate(scope, {
          entity: source.entity,
          table: from,
          id: sql`${table.shortcode}`,
          name: labelSql(source.entity, `"${getTableName(table)}"`),
          owners: routing.owners,
          where: await buildWhere(
            db,
            source.filters,
            needsProjectAttention(source) ? await attentionItems() : undefined,
          ),
          details,
          key: definition.key,
          shared: routing.shared,
        }),
      );
      continue;
    }
    if (!includeUnrecorded || excludedDiagnostics.has(source.diagnostic))
      continue;
    if (!privateDiagnosticKeys.has(definition.key)) {
      const result = await runDiagnostic(
        db,
        source.diagnostic,
        source.diagnostic === "project-date-window-drift"
          ? { attentionItems: await attentionItems() }
          : {},
        { kind: "count" },
      );
      if (result.count)
        selections.push(
          workDiagnosticCandidate(
            definition.key,
            `problem:${definition.key}`,
            definition.title,
            sql`ARRAY[]::uuid[]`,
            {
              ...details,
              reason: `${result.count} work items. ${definition.description}`,
            },
            true,
          ),
        );
      continue;
    }
    // These adapters compute their complete grouped relation once; no sample/count scan is repeated.
    const result = await runDiagnostic(
      db,
      source.diagnostic,
      {},
      { kind: "sample", limit: Number.POSITIVE_INFINITY },
    );
    for (const item of result.items) {
      const entry = privateProblemEntry(definition.key, item);
      const privateOwners = entry.refs.flatMap((ref) => {
        const relation = privateOwnerRelation(ref);
        return relation ? [relation] : [];
      });
      const owners = privateOwners.length
        ? sql.join(privateOwners, sql` || `)
        : sql`ARRAY[]::uuid[]`;
      selections.push(
        workDiagnosticCandidate(
          definition.key,
          `problem:${definition.key}:${await sha256Hex(entry.fingerprintPayload)}`,
          `${definition.title} · ${entry.refs.map((ref) => ref.shortcode).join(", ")}`,
          owners,
          { ...details, reason: entry.reason },
          privateOwners.length === 0,
        ),
      );
    }
  }
  for (const incomplete of includeAccounts
    ? await findIncompleteStatementImports(db)
    : []) {
    const owners = sql`coalesce((
      SELECT array_agg(DISTINCT account."ledgerPartyId")
      FROM "StatementImport" batch
      JOIN ${statementImportMembers} member ON member."importId" = batch.id
      JOIN "StatementRow" row ON row.id = member."statementRowId" AND row."deletedAt" IS NULL
      LEFT JOIN "FinancialAccount" account ON account.id = row."accountId" AND account."deletedAt" IS NULL
      WHERE batch.source = ${incomplete.source} AND batch.fingerprint = ${incomplete.fingerprint} AND batch."deletedAt" IS NULL
    ), ARRAY[NULL::uuid])`;
    selections.push(
      workDiagnosticCandidate(
        "incompleteStatementImports",
        `problem:incompleteStatementImports:${incomplete.source}:${incomplete.fingerprint}`,
        incomplete.label,
        owners,
        {
          source: "account",
          kind: "review",
          reason: `Statement import retained ${incomplete.rowCountStored} of ${incomplete.rowCountDeclared} declared rows.`,
          nextAction:
            "Open Problems to inspect the import and its current account evidence.",
        },
      ),
    );
  }
  return selections;
}
