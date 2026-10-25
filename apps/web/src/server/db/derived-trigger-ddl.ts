/**
 * Generated triggers that mark stored derived values dirty (ADR 0021).
 *
 * A trigger writes only marks it can name from the saved row: the row's own
 * target, or the old and new values of the column an input matches on. It
 * never queries dependents; a mark whose dependents are other rows is a
 * fanout mark the drain expands set-based outside the save (#2841: dependent
 * walks inside saves turned one Product save into a two-minute rollback).
 */
import {
  fanoutTarget,
  storedDerivedDeclarations,
} from "~/server/db/derived-declarations";

export const DERIVED_DRAIN_JOB_KEY = "derived:drain";

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const fnName = (table: string) =>
  `derived_mark_${table.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`;

/** One mark per changed input: the old and new matched column values. */
type TriggerInput = {
  target: string;
  tableColumn: string;
  columns: readonly string[] | null;
  where: Readonly<Record<string, string>> | null;
};

/** `row` holds every declared `where` value. */
const whereSql = (row: "OLD" | "NEW", where: TriggerInput["where"]) =>
  where
    ? Object.entries(where)
        .map(([column, value]) => `${row}.${ident(column)} = ${literal(value)}`)
        .join(" AND ")
    : "true";

const markStatement = (input: TriggerInput) => {
  const column = ident(input.tableColumn);
  const tracked = input.columns
    ? [...new Set([input.tableColumn, ...input.columns])]
    : null;
  const changed = tracked
    ? `(${tracked.map((name) => `OLD.${ident(name)}`).join(", ")}) IS DISTINCT FROM (${tracked.map((name) => `NEW.${ident(name)}`).join(", ")})`
    : `(to_jsonb(OLD) - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'updatedAt')`;
  // Row-valued comparison needs at least two members; one column compares directly.
  const changedCondition =
    tracked && tracked.length === 1
      ? `OLD.${column} IS DISTINCT FROM NEW.${column}`
      : changed;
  const target = literal(input.target);
  const oldWhere = whereSql("OLD", input.where);
  const newWhere = whereSql("NEW", input.where);
  return `  IF TG_OP = 'INSERT' THEN
    IF ${newWhere} THEN PERFORM derived_mark(${target}, ARRAY[NEW.${column}::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF ${oldWhere} THEN PERFORM derived_mark(${target}, ARRAY[OLD.${column}::uuid]); END IF;
  ELSIF (${oldWhere} OR ${newWhere}) AND ${changedCondition} THEN
    PERFORM derived_mark(${target}, ARRAY[OLD.${column}::uuid, NEW.${column}::uuid]);
  END IF;`;
};

/** Every source table's inputs, with fanout targets resolved. */
export function derivedTriggerInputs(): Map<string, TriggerInput[]> {
  const byTable = new Map<string, TriggerInput[]>();
  for (const declaration of storedDerivedDeclarations())
    for (const input of declaration.inputs) {
      const target =
        input.entityColumn === "id"
          ? declaration.target
          : fanoutTarget(declaration.target, input.entityColumn);
      const entries = byTable.get(input.table) ?? [];
      if (
        !entries.some(
          (entry) =>
            entry.target === target &&
            entry.tableColumn === input.tableColumn &&
            JSON.stringify(entry.columns) === JSON.stringify(input.columns) &&
            JSON.stringify(entry.where) === JSON.stringify(input.where),
        )
      )
        entries.push({
          target,
          tableColumn: input.tableColumn,
          columns: input.columns,
          where: input.where,
        });
      byTable.set(input.table, entries);
    }
  return new Map([...byTable].sort(([a], [b]) => a.localeCompare(b)));
}

/** The shared mark function: upsert a fresh ticket and capture the drain Job once per transaction. */
export const derivedMarkFunctionSql =
  () => `CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "DerivedDirty" (target, ref, priority)
    SELECT DISTINCT p_target, r, 0 FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    ticket = nextval('"DerivedTicket"'),
    priority = LEAST("DerivedDirty".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES (${literal(DERIVED_DRAIN_JOB_KEY)}, now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;`;

/** Desired-state DDL: the mark function plus one function and trigger per source table. */
export function derivedTriggerDdl(): string {
  const parts = [derivedMarkFunctionSql()];
  for (const [table, inputs] of derivedTriggerInputs()) {
    const fn = fnName(table);
    parts.push(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
${inputs.map(markStatement).join("\n")}
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ${ident(`${table}_derived_mark`)} ON ${ident(table)};
CREATE TRIGGER ${ident(`${table}_derived_mark`)} AFTER INSERT OR UPDATE OR DELETE ON ${ident(table)}
  FOR EACH ROW EXECUTE FUNCTION ${fn}();`);
  }
  return parts.join("\n\n");
}
