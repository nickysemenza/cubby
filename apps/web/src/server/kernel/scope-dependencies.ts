import { sql } from "drizzle-orm";

// Wide batches exceeded the statement time limit at 110,720 dependency rows.
// Around 16,000 keys per statement lowered synthetic writes to about 0.5 s.
// Keep an individual scope intact so removals compare its complete roster.
export function* scopeDependencyPages<T extends { keys: readonly string[] }>(
  rows: readonly T[],
): Iterable<T[]> {
  const maxDependenciesPerStatement = 16_000;
  let start = 0;
  while (start < rows.length) {
    let end = start + 1;
    let dependencies = rows[start]!.keys.length;
    while (
      end < rows.length &&
      dependencies + rows[end]!.keys.length <= maxDependenciesPerStatement
    ) {
      dependencies += rows[end]!.keys.length;
      end++;
    }
    yield rows.slice(start, end);
    start = end;
  }
}

/** Replace edges from the fenced roster. Both changes use the same stored set. */
export function scopeDependencyChanges(roster: "wanted" | "advanced") {
  const scopes = sql.identifier(roster);
  return sql`dependencies AS MATERIALIZED (
          SELECT wanted.kind, wanted.key, dependency.value AS dependency
          FROM ${scopes} wanted CROSS JOIN LATERAL jsonb_array_elements_text(wanted.keys) dependency(value)
        ), current_dependencies AS MATERIALIZED (
          SELECT w.kind, w.key, d.key AS dependency
          FROM ${scopes} w JOIN "ScopeDep" d
            ON d."scopeKind" = w.kind AND d."scopeKey" = w.key
        ), obsolete_dependencies AS (
          SELECT kind, key, dependency FROM current_dependencies
          EXCEPT SELECT kind, key, dependency FROM dependencies
        ), removed_dependencies AS (
          DELETE FROM "ScopeDep" d USING obsolete_dependencies k
          WHERE d."scopeKind" = k.kind AND d."scopeKey" = k.key AND d.key = k.dependency
          RETURNING 1
        ), added_dependencies AS (
          INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
          SELECT kind, key, dependency FROM dependencies
          EXCEPT SELECT kind, key, dependency FROM current_dependencies
          ON CONFLICT DO NOTHING RETURNING 1
        )`;
}
