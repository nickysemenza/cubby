import { randomBytes } from "node:crypto";
import { buildActorContext } from "@cubby/schemas/context";
import { testUserId } from "@cubby/schemas/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, beforeEach, vi } from "vitest";
import { createDatabase } from "~/server/db/database-runtime";
import { drizzleSchema as schema } from "~/server/db/drizzle-schema";
import { seedBaseWorld } from "../factories/base-world";
import { leaseNamedDatabase } from "../test-database-lease";
import type { withTestDb as ordinaryTestDb } from "../test-setup";

export function withTestDb(): ReturnType<typeof ordinaryTestDb> {
  const actor = buildActorContext(testUserId("synthetic-label-regression"));
  let current: Awaited<ReturnType<typeof freshDatabase>> | undefined;
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Regression forbids fetch"))),
    );
    current = await freshDatabase();
    await seedBaseWorld(current.client);
    await current.client.insert(schema.user).values({
      id: actor.userId,
      name: "Synthetic label member",
      email: "labels@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (!current) return;
    await current.pool.end();
    await current.lease.close();
    console.log(
      `Retained synthetic regression database: ${current.lease.name}`,
    );
    current = undefined;
  });
  return {
    actor,
    get db() {
      if (!current) throw new Error("Regression database is not ready");
      return current.db;
    },
    get databaseUrl() {
      if (!current) throw new Error("Regression database is not ready");
      return current.lease.databaseUrl;
    },
    async prepareFixture() {
      throw new Error("Retained cases use fresh data");
    },
    async fixture() {
      throw new Error("Retained cases use fresh data");
    },
  };
}

async function freshDatabase() {
  const { lease, prepared: pool } = await leaseNamedDatabase(
    {
      adminUrl: "postgresql://postgres:password@127.0.0.1:55432/postgres",
      name: `cubby_sim_${randomBytes(8).toString("hex")}`,
      retention: "retain",
    },
    async ({ databaseUrl }) =>
      new Pool({ connectionString: databaseUrl, max: 8 }),
  );
  const client = drizzle({ client: pool, schema });
  const db = createDatabase(() => ({
    client,
    withConnection: async (run) => {
      const connection = await pool.connect();
      try {
        return await run(drizzle({ client: connection, schema }));
      } finally {
        connection.release();
      }
    },
  }));
  return { lease, pool, client, db };
}
