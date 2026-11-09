import {
  entityFieldModels,
  entityFieldAssignmentKeys,
} from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { parseShortcode } from "@cubby/shared";
import { getTableColumns, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { minorToDollarsSql } from "~/server/db/computed/money";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { amountJsonSql } from "~/server/db/helpers/transform";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  currentReadFacts,
  type CurrentReadFacts,
} from "~/server/generic/derived/repo/read-context";

const intentRow = z.object({
  id: z.string(),
  raw: currentReadFacts,
});

/** Hydration may replace a stored value; page facts retain the assignment before that projection. */
export async function loadCurrentAssignmentFacts(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  ids: readonly string[],
  projected: ReadonlyMap<string, CurrentReadFacts> = new Map(),
  requested?: readonly string[],
): Promise<ReadonlyMap<string, CurrentReadFacts>> {
  const table = alias(SHORTCODE_TABLE[entity], "assignment_facts");
  const storedColumns: Readonly<Record<string, AnyColumn | undefined>> =
    getTableColumns(table);
  const model = entityFieldModels[entity];
  const keys = [
    ...new Set([
      ...entityFieldAssignmentKeys[entity],
      ...model.fields.flatMap((field) =>
        Object.keys(field.resolution?.none ?? {}),
      ),
    ]),
  ];
  const slots = keys
    .filter((key) => requested === undefined || requested.includes(key))
    .flatMap((key) => {
      const storage = model.storage.find((field) => field.key === key);
      if (storage?.specialized === "amount-columns") {
        const value = storedColumns[`${key}Value`];
        const unit = storedColumns[`${key}Unit`];
        if (!value || !unit)
          throw new Error(
            `Current ${entity}.${key} requires its declared amount columns`,
          );
        return [{ key, value: amountJsonSql(value, unit) }];
      }
      const column = storedColumns[key];
      return column
        ? [
            {
              key,
              value:
                storage?.specialized === "minor-unit-money"
                  ? minorToDollarsSql(column, "numeric")
                  : sql`${column}`,
            },
          ]
        : [];
    });
  if (!ids.length) return new Map();
  const columns = slots.flatMap(({ key, value }) => [sql`${key}::text`, value]);
  const rows = slots.length
    ? await repositoryQueries(db).execute(
        sql`
    SELECT ${table.id} AS id, jsonb_build_object(${sql.join(columns, sql`, `)}) AS raw
    FROM ${SHORTCODE_TABLE[entity]} AS ${sql.identifier("assignment_facts")}
    WHERE ${table.id} = ANY(${uuidArrayParam(ids)})`,
        "objects",
      )
    : [];
  const stored = new Map(
    z
      .array(intentRow)
      .parse(rows)
      .map((fact) => [fact.id, fact.raw]),
  );
  const facts = ids.map((id) => ({
    id,
    raw: { ...projected.get(id), ...stored.get(id) },
  }));
  const references = model.fields.filter(
    (field) =>
      field.kind === "identifier" &&
      field.reference &&
      (requested === undefined || requested.includes(field.key)),
  );
  const referenceIds = new Set<string>();
  for (const fact of facts)
    for (const field of references) {
      const value = fact.raw[field.key];
      if (value == null) continue;
      const physical = Object.hasOwn(stored.get(fact.id) ?? {}, field.key);
      for (const valueId of Array.isArray(value) ? value : [value]) {
        const id = physical ? z.string().parse(valueId) : valueId;
        if (typeof id !== "string" || parseShortcode(id)) continue;
        const parsed = z.uuid().safeParse(id);
        if (physical || parsed.success) referenceIds.add(z.uuid().parse(id));
      }
    }
  if (referenceIds.size) {
    const identities = await repositoryQueries(db).execute(
      sql`
      SELECT ${entityIdentity.id} AS id, ${entityIdentity.shortcode} AS shortcode
      FROM ${entityIdentity} WHERE ${entityIdentity.id} = ANY(${uuidArrayParam([...referenceIds])})`,
      "objects",
    );
    const codes = new Map(
      z
        .array(z.object({ id: z.string(), shortcode: z.string() }))
        .parse(identities)
        .map((identity) => [identity.id, identity.shortcode]),
    );
    const codeFor = (value: unknown, physical: boolean) => {
      const id = physical ? z.string().parse(value) : value;
      if (typeof id !== "string" || parseShortcode(id)) return id;
      const code = codes.get(id);
      if (!code && physical)
        throw new Error(
          `Current ${entity} assignment has no public reference identity`,
        );
      return code ?? id;
    };
    for (const fact of facts)
      for (const field of references) {
        const value = fact.raw[field.key];
        if (value == null) continue;
        const physical = Object.hasOwn(stored.get(fact.id) ?? {}, field.key);
        fact.raw[field.key] = Array.isArray(value)
          ? value.map((id) => codeFor(id, physical))
          : codeFor(value, physical);
      }
  }
  return new Map(facts.map((fact) => [fact.id, fact.raw]));
}
