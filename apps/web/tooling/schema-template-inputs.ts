/**
 * Every file whose contents decide the physical test-database schema. The
 * IntegreSQL template (and the E2E template) is keyed by a hash of these, so a
 * file missing here means a stale template is reused after a schema change and
 * every integration test that touches the new shape fails with a Postgres
 * error the developer can only clear by deleting the template by hand.
 *
 * Generated storage definitions participate for the same reason: omitting them
 * reuses a database whose columns no longer match the model.
 *
 * The `@cubby/schemas` entries are the modules `schema.ts` and the generated
 * columns import *values* from — constant arrays that become `pgEnum` values
 * or `text({ enum })` columns. Adding a value there changes the schema without
 * touching any file under `src/server/db`, which is exactly the miss that once
 * bit a new background-job kind.
 * `schema-template-inputs.unit.test.ts` derives the required list from the
 * imports and fails when this array falls behind. Paths resolve from
 * `apps/web` (the hasher joins them onto `process.cwd()`), which is where both
 * Vitest and Playwright run.
 */
export const schemaTemplateInputs = [
  "./src/server/db/schema.ts",
  "./src/server/db/auth.schema.ts",
  "./src/server/db/product-category-schema.ts",
  "./src/server/db/entity-identity-schema.ts",
  "../../packages/schemas/src/product-category-fields.ts",
  "./src/server/db/generated/**/*.ts",
  "../../packages/schemas/src/entity-attachment.ts",
  "../../packages/schemas/src/entity-manifest.ts",
  "../../packages/schemas/src/expense-line-kind.ts",
  "../../packages/schemas/src/image.ts",
  "../../packages/schemas/src/inventory-ownership.ts",
  "../../packages/schemas/src/meal-classification.ts",
  "../../packages/schemas/src/product.ts",
  "../../packages/schemas/src/project.ts",
  "../../packages/schemas/src/purchase.ts",
  "../../packages/schemas/src/purchase-import.ts",
  "../../packages/schemas/src/recipe-shared.ts",
];
