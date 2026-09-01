import assert from "node:assert/strict";
import test from "node:test";

import { resolvePostgresFamily } from "../apps/web/tooling/run-postgres-file.ts";

test("targeted PostgreSQL contract paths resolve to their family", () => {
  assert.equal(
    resolvePostgresFamily("src/server/repo/expense.integration.test.ts"),
    "src/server/integration-families/financial.integration.test.ts",
  );
  assert.equal(
    resolvePostgresFamily(
      "src/server/integration-families/inventory.integration.test.ts",
    ),
    "src/server/integration-families/inventory.integration.test.ts",
  );
});
