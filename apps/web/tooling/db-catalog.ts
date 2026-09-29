import { Client } from "pg";

/**
 * The physical `public` schema as PostgreSQL itself renders it, keyed by
 * object identity so two databases compare regardless of creation order.
 * `db:check` compares a migrations-built database against one built from
 * `schema.ts`; after cutover the same read runs against production.
 *
 * Extension-owned objects (`pg_trgm` functions, `pg_stat_statements` views)
 * and internal (foreign-key) triggers are excluded: they are not part of the
 * application schema and differ by host. The `drizzle` bookkeeping schema is
 * out of scope because only `public` is read.
 */
export interface SchemaCatalog {
  relations: Record<string, string>;
  columns: Record<string, string>;
  constraints: Record<string, string>;
  indexes: Record<string, string>;
  triggers: Record<string, string>;
  functions: Record<string, string>;
  enums: Record<string, string>;
}

type CatalogQueries = { [K in keyof SchemaCatalog]: string };

const notExtensionMember = (oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid IN ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_type'::regclass) AND d.objid = ${oid} AND d.deptype = 'e')`;

const CATALOG_QUERIES: CatalogQueries = {
  relations: `
    SELECT c.relname AS key, c.relkind::text AS value
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND ${notExtensionMember("c.oid")}`,
  columns: `
    SELECT format('%I.%I', c.relname, a.attname) AS key,
      concat_ws(' ', format_type(a.atttypid, a.atttypmod),
        CASE WHEN a.attnotnull THEN 'NOT NULL' END,
        CASE WHEN a.attidentity <> '' THEN 'IDENTITY ' || a.attidentity::text END,
        CASE WHEN a.attgenerated <> '' THEN 'GENERATED ' || pg_get_expr(ad.adbin, ad.adrelid)
             WHEN ad.adbin IS NOT NULL THEN 'DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid) END,
        CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
             THEN 'COLLATE ' || a.attcollation::regcollation::text END) AS value
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND ${notExtensionMember("c.oid")}`,
  constraints: `
    SELECT format('%I.%I', c.relname, con.conname) AS key,
      con.contype::text || ' ' || pg_get_constraintdef(con.oid) AS value
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND ${notExtensionMember("c.oid")}`,
  indexes: `
    SELECT format('%I.%I', i.tablename, i.indexname) AS key, i.indexdef AS value
    FROM pg_indexes i
    JOIN pg_class c ON c.relname = i.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
    WHERE i.schemaname = 'public' AND ${notExtensionMember("c.oid")}`,
  triggers: `
    SELECT format('%I.%I', c.relname, t.tgname) AS key,
      pg_get_triggerdef(t.oid) AS value
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  functions: `
    SELECT format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS key,
      pg_get_functiondef(p.oid) AS value
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND ${notExtensionMember("p.oid")}`,
  enums: `
    SELECT t.typname AS key,
      string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS value
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND ${notExtensionMember("t.oid")}
    GROUP BY t.typname`,
};

/**
 * Read the catalog through its own read-only session, so pointing it at the
 * production database can never write.
 */
export async function readSchemaCatalog(
  connectionString: string,
): Promise<SchemaCatalog> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const read = async (text: string) => {
      const { rows } = await client.query<{ key: string; value: string }>(text);
      const record: Record<string, string> = {};
      for (const row of rows) record[row.key] = row.value;
      return record;
    };
    return {
      relations: await read(CATALOG_QUERIES.relations),
      columns: await read(CATALOG_QUERIES.columns),
      constraints: await read(CATALOG_QUERIES.constraints),
      indexes: await read(CATALOG_QUERIES.indexes),
      triggers: await read(CATALOG_QUERIES.triggers),
      functions: await read(CATALOG_QUERIES.functions),
      enums: await read(CATALOG_QUERIES.enums),
    };
  } finally {
    await client.end();
  }
}

/**
 * Every difference between two catalogs as one readable line each; empty when
 * they are equal.
 */
export function diffSchemaCatalogs(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  labels: { expected: string; actual: string } = {
    expected: "expected",
    actual: "actual",
  },
): string[] {
  const differences: string[] = [];
  for (const category of Object.keys(CATALOG_QUERIES)) {
    // SAFETY: iterating CATALOG_QUERIES' own keys.
    const key = category as keyof SchemaCatalog;
    const left = expected[key];
    const right = actual[key];
    for (const name of [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort()) {
      const a = left[name];
      const b = right[name];
      if (a === b) continue;
      if (a === undefined)
        differences.push(`${category} ${name}: only in ${labels.actual}: ${b}`);
      else if (b === undefined)
        differences.push(
          `${category} ${name}: only in ${labels.expected}: ${a}`,
        );
      else
        differences.push(
          `${category} ${name}: ${labels.expected}=${a} | ${labels.actual}=${b}`,
        );
    }
  }
  return differences;
}
