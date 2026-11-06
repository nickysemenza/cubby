import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { GeneratedEntityFieldModel } from "@cubby/schemas/entity-projection-types";
import { fieldResult, fieldSource } from "@cubby/schemas/field-envelope";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import { expenseId } from "@cubby/schemas/identifiers";
import { rawExpenseOut } from "@cubby/schemas/work-raw-read";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { readExpenseById } from "~/server/domains/expense/repo/crud";
import { expenseSpendingCategoryResolutionSql } from "~/server/domains/expense/repo/expense-category-resolution";
import { resolveDraftExpenseFields } from "~/server/domains/expense/repo/expense-inheritance";
import {
  financialTransactionEvidenceFieldResolutionsSql,
  purchaseEvidenceFieldResolutionsSql,
  vendorEvidenceFieldResolutionsSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { explanationReferenceValues } from "~/server/generic/field-explanation/repo/explanation-reference-values";

const resultSchema = fieldResult(z.json());
type Resolution = NonNullable<
  GeneratedEntityFieldModel["fields"][number]["resolution"]
>;

async function expenseInheritanceReset(
  db: Database,
  field: string,
  internalId: string,
  patch: NonNullable<Resolution["reset"]>,
) {
  const row = await readExpenseById(db, expenseId.parse(internalId));
  const draft = rawExpenseOut
    .pick({
      name: true,
      lineKind: true,
      projectId: true,
      productId: true,
      purchaseId: true,
      trade: true,
      costType: true,
    })
    .parse({
      ...row,
      projectId: row.fieldResolutions?.projectId?.storedValue ?? null,
      trade: row.fieldResolutions?.trade?.storedValue ?? null,
      ...patch,
    });
  const resolution = (await resolveDraftExpenseFields(db, draft))[field];
  if (!resolution) throw new Error("Expense reset resolution was not found");
  return resolution;
}

/** These ports reuse ordinary resolution; declarations choose the source. */
const sources = {
  vendorEvidence: {
    resolution: (alias: string, field: string) =>
      sql`${vendorEvidenceFieldResolutionsSql(alias)} -> ${field}`,
    mechanism: "computed",
  },
  purchaseEvidence: {
    resolution: (alias: string, field: string) =>
      sql`${purchaseEvidenceFieldResolutionsSql(alias)} -> ${field}`,
    mechanism: "default",
  },
  transactionEvidence: {
    resolution: (alias: string, field: string) =>
      sql`${financialTransactionEvidenceFieldResolutionsSql(alias)} -> ${field}`,
    mechanism: "default",
  },
  expenseInheritance: {
    resolve: expenseInheritanceReset,
    mechanism: "default",
  },
  expenseCategory: {
    resolution: (alias: string, _field: string) =>
      expenseSpendingCategoryResolutionSql(alias),
    mechanism: "default",
  },
} as const satisfies Record<
  NonNullable<Resolution["resetSource"]>,
  { mechanism: "computed" | "default" } & (
    | { resolution: (alias: string, field: string) => SQL }
    | { resolve: typeof expenseInheritanceReset }
  )
>;

/** Apply the ordinary reset patch to a typed row without writing any data. */
export async function declaredResetPreview(
  db: Database,
  entity: Entity,
  field: string,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  const declaration: Resolution | null | undefined = entityFieldModels[
    entity
  ].fields.find((entry) => entry.key === field)?.resolution;
  if (!declaration?.resetSource) return null;
  const source = sources[declaration.resetSource];
  const { dbTable, softDelete } = entityManifest[entity];
  if (!dbTable) throw new Error("Reset source requires a stored entity");
  const table = sql.identifier(dbTable);
  const resolution =
    "resolve" in source
      ? await source.resolve(db, field, internalId, declaration.reset ?? {})
      : await (async () => {
          const rows = await repositoryQueries(db).execute(sql`SELECT
    ${source.resolution("reset_row", field)} AS resolution
    FROM ${table} AS reset_original
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},
      to_jsonb(reset_original) || ${JSON.stringify(declaration.reset)}::jsonb) AS reset_row
    WHERE reset_original.id = ${internalId}::uuid
      ${softDelete ? sql`AND ${notDeleted("reset_original")}` : sql``}`);
          if (!rows.rows[0])
            throw new Error("Reset preview record was not found");
          return fieldResolutionSchema.parse(rows.rows[0].resolution);
        })();
  const [publicValue] = await explanationReferenceValues(db, [
    { value: resolution.value, source: resolution.sourceEntity },
  ]);
  const current = z
    .object({
      value: z.json(),
      source: fieldSource.nullable(),
    })
    .parse(publicValue);
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome:
        current.value === null
          ? { kind: "empty", reason: resolution.emptyReason ?? "unset" }
          : { kind: "value", value: current.value },
      provenance: current.source
        ? { kind: "inherited", source: current.source }
        : current.value === null
          ? null
          : source.mechanism === "computed"
            ? { kind: "computed" }
            : { kind: "default", source: null },
    },
  });
}
