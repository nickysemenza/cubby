import "./build-constants";
import { buildActorContext } from "@cubby/schemas/context";
import { testUserId } from "@cubby/schemas/testing";
import type { Page } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import { Database } from "~/server/db";
import * as schema from "~/server/db/schema";
import type { EntityBrowserMutationCommand } from "~/server/entity-kernel/contracts";
import {
  type CreatableEntity,
  createEntity,
  type EntityOverrides,
} from "../../tooling/factories/build";
import {
  buildKernelContext,
  createFixtureWithContext,
} from "../../tooling/scenarios/context";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { e2eFaker } from "./e2e-helpers";

type CreatedEntity = { id: string };

const fixtureSessionSchema = z.object({
  user: z.object({ id: z.string().min(1) }).optional(),
});

type FixtureUserId = ReturnType<typeof testUserId>;

let fixtureDb: Database | undefined;

const fixtureUserIds = new WeakMap<object, Promise<FixtureUserId>>();

export function getFixtureDb(): Database {
  if (fixtureDb) return fixtureDb;
  const connectionString =
    process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "E2E_DATABASE_URL is required for server-side Playwright fixtures",
    );
  }
  // Room for FIXTURE_CONCURRENCY parallel writes plus their nested reads.
  const pool = new Pool({ connectionString, max: 8, allowExitOnIdle: true });
  const client = drizzle(pool, { schema });
  fixtureDb = new Database(() => ({
    client,
    withConnection: (run) => run(client),
  }));
  return fixtureDb;
}

export function fixtureUserId(page: Page): Promise<FixtureUserId> {
  const context = page.context();
  const existing = fixtureUserIds.get(context);
  if (existing) return existing;

  const pending = (async () => {
    const response = await page.request.get("/api/auth/get-session");
    if (!response.ok()) {
      throw new Error(`Fixture session lookup failed: ${response.status()}`);
    }
    const session = fixtureSessionSchema.parse(await response.json());
    const userId = session.user?.id;
    if (!userId) {
      throw new Error("Fixture session has no authenticated user id");
    }
    return testUserId(userId);
  })();
  fixtureUserIds.set(context, pending);
  return pending;
}

/** Authenticated binding for production import writers in convergence scenarios.
 * Economic records are created by those writers, never fixture inserts. */
export async function createEvidenceHarnessContext(page: Page) {
  const userId = await fixtureUserId(page);
  return { db: getFixtureDb(), actor: buildActorContext(userId, "web") };
}

/** Parallel fixture writes; bounded so a large seed does not queue on the pool. */
const FIXTURE_CONCURRENCY = 4;

export async function seedConcurrently<Item, Result>(
  items: readonly Item[],
  run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  // One shared iterator: each lane takes the next item as it frees up.
  const queue = items.entries();
  const lane = async () => {
    for (const [index, item] of queue) results[index] = await run(item);
  };
  await Promise.all(
    Array.from({ length: Math.min(FIXTURE_CONCURRENCY, items.length) }, lane),
  );
  return results;
}

export async function createFixture<Input>(
  page: Page,
  entity: Extract<EntityBrowserMutationCommand, { action: "create" }>["entity"],
  input: Input,
): Promise<CreatedEntity> {
  const context = buildKernelContext(getFixtureDb(), await fixtureUserId(page));
  return createFixtureWithContext(context, entity, input);
}

/** The kernel context a fixture writes through, acting as the page's signed-in user. */
export async function fixtureKernelContext(page: Page) {
  return buildKernelContext(getFixtureDb(), await fixtureUserId(page));
}

/**
 * Create one entity from factory defaults plus `overrides`. Filler fields come
 * from the running test's seeded Faker; anything a test asserts on (a name it
 * locates by) belongs in `overrides`, shaped `${label} ${token}`.
 */
export async function createEntityFixture<E extends CreatableEntity>(
  page: Page,
  entity: E,
  overrides: EntityOverrides<E> = {},
): Promise<CreatedEntity> {
  return createEntity(await fixtureKernelContext(page), entity, overrides, {
    faker: e2eFaker(),
  });
}

/** The signed-in user's member LedgerParty, created on first use. */
export async function ensureMemberParty(page: Page, name: string) {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);
  const existing = await getDb(db).query.ledgerParty.findFirst({
    where: and(
      eq(schema.ledgerParty.userId, userId),
      eq(schema.ledgerParty.kind, "member"),
      isNull(schema.ledgerParty.deletedAt),
    ),
  });
  return (
    existing ??
    (await insertWithShortcode(db, "ledgerParty", {
      name: `${name} member`,
      kind: "member",
      userId,
    }))
  );
}
