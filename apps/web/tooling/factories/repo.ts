import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type { Database } from "~/server/db";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { createFinancialAccount } from "~/server/domains/financial-account/repo";
import { createFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import { createProductCategory } from "~/server/domains/product-category/repo/product-category";
import { createProject } from "~/server/domains/project/repo/crud";
import { createPurchase } from "~/server/domains/purchase/repo/purchase";
import { createTask, createTaskRead } from "~/server/domains/task/repo/crud";
import { createVendor } from "~/server/domains/vendor/repo/vendor";
import { createVendorAccount } from "~/server/domains/vendor-account/repo/vendor-account";

import {
  type BuildOptions,
  buildEntity,
  type CreatableEntity,
  type EntityInput,
  type EntityOverrides,
} from "./build";

/**
 * Repo-level writer variant of `createEntity`: build the factory input, then
 * write it through the entity's repository `create*` function, skipping the
 * entity kernel. Repo integration tests use it so a row that is only setup
 * costs one call. Each repo writer takes `(db, input, actor)`; only entities
 * with that exact signature are listed.
 */
const REPO_WRITERS = {
  expense: createExpense,
  financialAccount: createFinancialAccount,
  financialTransaction: createFinancialTransaction,
  ledgerParty: createLedgerParty,
  productCategory: createProductCategory,
  project: createProject,
  purchase: createPurchase,
  task: createTask,
  vendor: createVendor,
  vendorAccount: createVendorAccount,
} satisfies {
  [E in CreatableEntity]?: (
    db: Database,
    input: EntityInput<E>,
    actor: ActorContext,
  ) => Promise<object>;
};

type RepoWriterEntity = keyof typeof REPO_WRITERS;
/** The writers re-keyed so indexing by a generic entity keeps its own input type. */
type RepoWriters = {
  [K in RepoWriterEntity]: (
    db: Database,
    input: EntityInput<K>,
    actor: ActorContext,
  ) => ReturnType<(typeof REPO_WRITERS)[K]>;
};
const writers: RepoWriters = REPO_WRITERS;

const mutationIdentity = z.object({ id: z.string().min(1) });

/** Preserve the writer's validation, audit and publication; omit unused response hydration. */
function identityWriter<
  E extends RepoWriterEntity,
  Args extends unknown[],
  Result extends { output: unknown },
>(
  entity: E,
  read: (fields: readonly string[], ...args: Args) => Promise<Result>,
) {
  return async (...args: Args) => {
    const result = await read(["id"], ...args);
    return {
      ...result,
      output: {
        id: parseShortcodeFor(entity, mutationIdentity.parse(result.output).id),
      },
    };
  };
}

const IDENTITY_WRITERS = {
  expense: identityWriter("expense", createExpense.read),
  financialAccount: identityWriter(
    "financialAccount",
    createFinancialAccount.read,
  ),
  financialTransaction: identityWriter(
    "financialTransaction",
    createFinancialTransaction.read,
  ),
  ledgerParty: identityWriter("ledgerParty", createLedgerParty.read),
  productCategory: identityWriter(
    "productCategory",
    createProductCategory.read,
  ),
  project: identityWriter("project", createProject.read),
  purchase: identityWriter("purchase", createPurchase.read),
  task: identityWriter(
    "task",
    (fields, db: Database, input: EntityInput<"task">, actor: ActorContext) =>
      createTaskRead(db, input, actor, fields),
  ),
  vendor: identityWriter("vendor", createVendor.read),
  vendorAccount: identityWriter("vendorAccount", createVendorAccount.read),
};
type IdentityWriters = {
  [K in RepoWriterEntity]: (
    db: Database,
    input: EntityInput<K>,
    actor: ActorContext,
  ) => ReturnType<(typeof IDENTITY_WRITERS)[K]>;
};
const identityWriters: IdentityWriters = IDENTITY_WRITERS;

/** The `{ db, actor }` pair `withTestDb()` hands every integration test. */
export interface RepoContext {
  db: Database;
  actor: ActorContext;
}

/** Setup that only consumes a shortcode/UUID does not need a detail response. */
export function createRepoIdentity<E extends RepoWriterEntity>(
  context: RepoContext,
  entity: E,
  overrides: EntityOverrides<E> = {},
  opts: BuildOptions = {},
): ReturnType<(typeof IDENTITY_WRITERS)[E]> {
  return identityWriters[entity](
    context.db,
    buildEntity(entity, overrides, opts),
    context.actor,
  );
}

export function createRepoEntity<E extends RepoWriterEntity>(
  context: RepoContext,
  entity: E,
  overrides: EntityOverrides<E> = {},
  opts: BuildOptions = {},
): ReturnType<(typeof REPO_WRITERS)[E]> {
  const input = buildEntity(entity, overrides, opts);
  return writers[entity](context.db, input, context.actor);
}
