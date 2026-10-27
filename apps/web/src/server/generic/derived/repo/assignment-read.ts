import {
  entityFieldModels,
  entityFieldAssignmentKeys,
} from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { getTableColumns, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

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
  const slots = keys.flatMap((key) => {
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
    return column ? [{ key, value: sql`${column}` }] : [];
  });
  if (!ids.length || !slots.length) return new Map();
  const columns = slots.flatMap(({ key, value }) => [sql`${key}::text`, value]);
  const rows = await repositoryQueries(db).execute(sql`
    SELECT ${table.id} AS id, jsonb_build_object(${sql.join(columns, sql`, `)}) AS raw
    FROM ${SHORTCODE_TABLE[entity]} AS ${sql.identifier("assignment_facts")}
    WHERE ${table.id} = ANY(${uuidArrayParam(ids)})`);
  const facts = z.array(intentRow).parse(rows.rows);
  const references = model.fields.filter(
    (field) => field.reference && keys.includes(field.key),
  );
  const referenceIds = new Set<string>();
  for (const fact of facts)
    for (const field of references) {
      const value = fact.raw[field.key];
      if (value == null) continue;
      for (const id of Array.isArray(value)
        ? z.array(z.uuid()).parse(value)
        : [z.uuid().parse(value)])
        referenceIds.add(id);
    }
  if (referenceIds.size) {
    const identities = await repositoryQueries(db).execute(sql`
      SELECT ${entityIdentity.id} AS id, ${entityIdentity.shortcode} AS shortcode
      FROM ${entityIdentity} WHERE ${entityIdentity.id} = ANY(${uuidArrayParam([...referenceIds])})`);
    const codes = new Map(
      z
        .array(z.object({ id: z.string(), shortcode: z.string() }))
        .parse(identities.rows)
        .map((identity) => [identity.id, identity.shortcode]),
    );
    const codeFor = (id: string) => {
      const code = codes.get(id);
      if (!code)
        throw new Error(
          `Current ${entity} assignment has no public reference identity`,
        );
      return code;
    };
    for (const fact of facts)
      for (const field of references) {
        const value = fact.raw[field.key];
        if (value == null) continue;
        fact.raw[field.key] = Array.isArray(value)
          ? z.array(z.uuid()).parse(value).map(codeFor)
          : codeFor(z.uuid().parse(value));
      }
  }
  return new Map(facts.map((fact) => [fact.id, fact.raw]));
}
