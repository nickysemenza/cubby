import { generatedHeader } from "../../artifacts.ts";
import { EntityDeclarationError, stringValue } from "../declarations.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { lowerCamelCase } from "./routes.ts";

/**
 * `coverage-totals.gen.ts`: the Problems page's coverage-meter denominators
 * that are a data-quality check's own `expected` population. A check declares
 * `coverage: "<meter>"` (a `coverageTotalsSchema` key); this counts the
 * entity's live rows under that check's `expectedCondition`, so the meter's
 * "N of M" and the check's `dataGaps` filter cannot scope different sets. A
 * meter whose population is not a check (leaf locations, stocked locations)
 * stays a hand-written count in `detectors-coverage.ts`.
 */
export const renderCoverageTotalsArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const meters = new Map<
    string,
    { entity: string; table: string; check: string }
  >();
  for (const entity of entities) {
    for (const check of entity.dataQuality?.checks ?? []) {
      if (check.coverage === undefined) continue;
      if (meters.has(check.coverage))
        throw new EntityDeclarationError(
          `Coverage meter ${check.coverage} is claimed by more than one data-quality check.`,
        );
      meters.set(check.coverage, {
        entity: entity.key,
        table: lowerCamelCase(
          stringValue(
            entity.descriptor.dbTable ?? null,
            `${entity.key}.dbTable`,
          ),
        ),
        check: check.id,
      });
    }
  }
  if (meters.size === 0) return [];
  const tables = [...new Set([...meters.values()].map(({ table }) => table))]
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
  const entries = [...meters.entries()]
    .map(
      ([meter, { entity, table, check }]) =>
        `    ${meter}: first(await client.select({ count: COUNT }).from(${table}).where(and(notDeleted(${table}), expectedCondition(${JSON.stringify(entity)}, ${JSON.stringify(check)})))),`,
    )
    .join("\n");
  return [
    {
      relativePath: "apps/web/src/server/repo/problems/coverage-totals.gen.ts",
      source:
        generatedHeader +
        'import type { CoverageTotals } from "@cubby/schemas/problems";\n' +
        'import { and, sql } from "drizzle-orm";\n\n' +
        'import type { Database } from "~/server/db";\n' +
        `import { ${tables} } from "~/server/db/schema";\n` +
        'import { expectedCondition } from "~/server/repo/data-quality/sql";\n' +
        'import { getDb, notDeleted } from "~/server/repo/database-helpers";\n\n' +
        "const COUNT = sql<number>`count(*)::int`;\n" +
        "const first = (rows: Array<{ count: number }>): number =>\n  Number(rows[0]?.count ?? 0);\n\n" +
        "export const findCheckCoverageTotals = async (\n  db: Database,\n): Promise<Pick<CoverageTotals, " +
        [...meters.keys()].map((meter) => JSON.stringify(meter)).join(" | ") +
        ">> => {\n  const client = getDb(db);\n  return {\n" +
        entries +
        "\n  };\n};\n",
    },
  ];
};
