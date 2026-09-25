import type { UserId } from "@cubby/schemas/identifiers";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { z } from "zod";

import { Database } from "~/server/db";
import { tracePool } from "~/server/db-pg-tracing";
import * as schema from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import {
  entityBrowserMutationCommandSchema,
  type EntityBrowserMutationCommand,
} from "~/server/entity-kernel/contracts";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * The reusable core of scenario/fixture creation, shared by the Playwright
 * fixtures (`tests/e2e/e2e-fixtures.ts`, which resolve the actor from a
 * `Page`'s session) and the dev-database corpus (`dev-db-seed.ts`, which
 * already knows its one local user's id). Keep this module free of anything
 * Playwright- or corpus-specific — it is the shared middle layer, not either
 * caller's policy.
 */

export type KernelContext = ReturnType<typeof requireActor>;
export type CreatedEntity = { id: string };

const createdEntitySchema = z.object({ id: z.string().min(1) });

/** Wrap a plain `pg` pool as the repository-facing `Database` handle scenario builders need. */
export function buildScenarioDatabase(pool: Pool): Database {
  // The production wrapper: one statement at a time per connection.
  const client = drizzle(tracePool(pool, "strong"), { schema });
  return new Database(() => ({
    client,
    withConnection: (run) => run(client),
  }));
}

/** Build the entity-kernel context a scenario builder executes commands through. */
export function buildKernelContext(
  db: Database,
  userId: UserId,
): KernelContext {
  return requireActor(createTestRequestContext(db, { auth: { userId } }));
}

/** Create one entity through the same browser-mutation path the UI uses. */
export async function createFixtureWithContext<Input>(
  context: KernelContext,
  entity: Extract<EntityBrowserMutationCommand, { action: "create" }>["entity"],
  input: Input,
): Promise<CreatedEntity> {
  const command = entityBrowserMutationCommandSchema.parse({
    action: "create",
    entity,
    data: input,
  });
  const result = await executeEntity(context, command);
  if (result.action !== "create") {
    throw new Error(`Fixture ${entity}.create returned the wrong action`);
  }
  return createdEntitySchema.parse(result.item);
}
