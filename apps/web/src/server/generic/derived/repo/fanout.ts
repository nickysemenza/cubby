import { type SQL, sql } from "drizzle-orm";

/** Parameterized prefix bounds remain indexable inside correlated page reads. */
export const fanoutTargetMatches = (column: SQL, target: SQL): SQL =>
  // Fanout names append '@' to a complete target. 'A' is its next C-collation
  // character, so this half-open range admits exactly that target's fanouts.
  sql`(${column} COLLATE "C" >= (${target} || '@') COLLATE "C"
    AND ${column} COLLATE "C" < (${target} || 'A') COLLATE "C")`;
