import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db";
import { createExpense } from "~/server/repo/expense";
import { createFinancialAccount } from "~/server/repo/financial-account";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { createProductCategory } from "~/server/repo/product-category";
import { createProject } from "~/server/repo/project";
import { createPurchase } from "~/server/repo/purchase";
import { createTask } from "~/server/repo/task";
import { createVendor } from "~/server/repo/vendor";
import { createVendorAccount } from "~/server/repo/vendor-account";

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

/** The `{ db, actor }` pair `withTestDb()` hands every integration test. */
export interface RepoContext {
  db: Database;
  actor: ActorContext;
}

export function createRepoEntity<E extends RepoWriterEntity>(
  context: RepoContext,
  entity: E,
  overrides: EntityOverrides<E> = {},
  opts: BuildOptions = {},
): ReturnType<(typeof REPO_WRITERS)[E]> {
  const input = buildEntity(entity, overrides, opts);
  const write: (
    db: Database,
    input: EntityInput<E>,
    actor: ActorContext,
  ) => ReturnType<(typeof REPO_WRITERS)[E]> = REPO_WRITERS[entity];
  return write(context.db, input, context.actor);
}
