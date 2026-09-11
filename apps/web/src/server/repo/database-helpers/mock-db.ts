/**
 * Test-only `Database` handle for where-builder guard tests.
 *
 * Query construction in Drizzle is lazy: `db.select().from(x).where(y)` never
 * touches the network, it just builds a query-builder object. `drizzle.mock()`
 * (see `database.unit.test.ts`) gives us a real Drizzle client wired to no
 * connection at all, and `PgDialect().sqlToQuery(...)` compiles a `SQL` node
 * straight to the text a real query would send — so a `build<Entity>Where`
 * function can be exercised and its SQL text asserted on without a live
 * Postgres connection.
 *
 * Only for repo-level where-builder guard tests (`*.unit.test.ts` next to a
 * `build<Entity>Where`/`build<Entity>WhereClause`). Not a general Database
 * test double — it cannot execute anything, only build query text.
 */
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";

import { Database } from "~/server/db/database";
import * as schema from "~/server/db/schema";

const dialect = new PgDialect();

/** A fresh mock-backed `Database` handle for one test. */
export const mockWhereDatabase = (): Database =>
  new Database(() => {
    const client = drizzle.mock({ schema });
    return { client, withConnection: (fn) => fn(client) };
  });

/** Render a where-builder's result to the SQL text it would send. */
export const renderWhereSql = (where: SQL | undefined): string | undefined =>
  where ? dialect.sqlToQuery(where).sql : undefined;
