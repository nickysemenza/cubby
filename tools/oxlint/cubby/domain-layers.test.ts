import assert from "node:assert/strict";
import test from "node:test";

import { targetPath, violation } from "./rules/domain-layers.ts";

const S = "apps/web/src/server";

test("server roles import only the same or a lower layer", () => {
  assert.equal(
    violation(
      `${S}/domains/product/repo/crud.ts`,
      `${S}/domains/product/service/product.service.ts`,
      false,
    ),
    "upward",
  );
  assert.equal(
    violation(
      `${S}/domains/product/service.ts`,
      `${S}/domains/recipe/operations.server.ts`,
      false,
    ),
    "upward",
  );
  assert.equal(
    violation(
      `${S}/domains/product/operations.server.ts`,
      `${S}/domains/recipe/repo.ts`,
      false,
    ),
    undefined,
  );
  assert.equal(
    violation(
      `${S}/domains/wish/repo.ts`,
      `${S}/domains/product/repo/crud.ts`,
      false,
    ),
    undefined,
  );
  // `product-category` must never be read as `product`'s role folder.
  assert.equal(
    violation(
      `${S}/domains/product-category/repo.ts`,
      `${S}/domains/product/repo/crud.ts`,
      false,
    ),
    undefined,
  );
});

test("repo stays off ai/ and services stay off the schema and helpers", () => {
  assert.equal(
    violation(`${S}/domains/image/repo/image.ts`, `${S}/ai/gateway`, false),
    "repoAi",
  );
  assert.equal(
    violation(
      `${S}/domains/image/service/image-storage.service.ts`,
      `${S}/db/schema`,
      true,
    ),
    "serviceDb",
  );
  assert.equal(
    violation(
      `${S}/domains/image/service/image-storage.service.ts`,
      `${S}/db/helpers`,
      false,
    ),
    "serviceDb",
  );
  assert.equal(
    violation(
      `${S}/domains/image/service/image-storage.service.ts`,
      `${S}/db`,
      false,
    ),
    "serviceDb",
  );
  assert.equal(
    violation(
      `${S}/domains/run/service/execution-context.ts`,
      `${S}/db/auth.schema`,
      true,
    ),
    "serviceDb",
  );
  assert.equal(
    violation(
      `${S}/domains/image/service/image-storage.service.ts`,
      `${S}/db`,
      true,
    ),
    undefined,
  );
  assert.equal(
    violation(
      `${S}/domains/recipe/service/recipe.service.ts`,
      `${S}/db/freshness/client`,
      false,
    ),
    undefined,
  );
  assert.equal(
    violation(
      `${S}/domains/product/repo/merge.ts`,
      `${S}/ai/repo/ai-usage`,
      false,
    ),
    undefined,
  );
});

test("ai/repo ranks as repo and ai/policy stays free of model code", () => {
  assert.equal(
    violation(`${S}/ai/repo/ai-refresh.ts`, `${S}/ai/decision-model`, false),
    "repoAi",
  );
  assert.equal(
    violation(`${S}/db/computed/relations.ts`, `${S}/ai/repo/ai-usage`, false),
    "upward",
  );
  assert.equal(
    violation(
      `${S}/domains/product/repo/product-variant-evidence.ts`,
      `${S}/ai/policy/refresh-manifest`,
      false,
    ),
    undefined,
  );
  assert.equal(
    violation(`${S}/ai/policy/features.ts`, `${S}/ai/run-feature`, false),
    "policyImpure",
  );
  assert.equal(
    violation(`${S}/ai/policy/features.ts`, `${S}/ai/run-feature`, true),
    undefined,
  );
  assert.equal(
    violation(
      `${S}/ai/policy/refresh-manifest.ts`,
      `${S}/ai/policy/field-decisions`,
      false,
    ),
    undefined,
  );
});

test("platform and generic code never reach a domain's service or operations", () => {
  assert.equal(
    violation(
      `${S}/entity-kernel/actions.ts`,
      `${S}/domains/product/service/product.service`,
      false,
    ),
    "platformUpward",
  );
  assert.equal(
    violation(
      `${S}/generic/entity-timeline/index.ts`,
      `${S}/domains/product/operations/product.server`,
      false,
    ),
    "platformUpward",
  );
  assert.equal(
    violation(
      `${S}/generic/merge/operations/merge.server.ts`,
      `${S}/domains/product/service/product.service`,
      false,
    ),
    "platformUpward",
  );
  assert.equal(
    violation(`${S}/mcp/tools.ts`, `${S}/domains/product/repo/crud`, false),
    undefined,
  );
  // Role-less files anywhere (including feature domains) rank as platform.
  assert.equal(
    violation(
      `${S}/domains/purchase-import/gmail/server.ts`,
      `${S}/domains/product/service/product.service`,
      false,
    ),
    "platformUpward",
  );
});

test("http, mcp, and workflows import like operations and stay importable", () => {
  assert.equal(
    violation(
      `${S}/http/request-services.ts`,
      `${S}/domains/recipe/service/recipe-costing.service`,
      false,
    ),
    undefined,
  );
  assert.equal(
    violation(
      `${S}/workflows/ai-refresh.ts`,
      `${S}/domains/run/service/ai-refresh`,
      false,
    ),
    undefined,
  );
  assert.equal(
    violation(`${S}/domains/run/repo/run.ts`, `${S}/workflows/runtime`, false),
    undefined,
  );
});

test("client boundaries and type-only imports", () => {
  assert.equal(
    violation(
      "apps/web/src/ui/layout/stack.tsx",
      "apps/web/src/entity/entities",
      false,
    ),
    "uiUpward",
  );
  assert.equal(
    violation(
      "apps/web/src/entity/entities.tsx",
      "apps/web/src/features/product/slots",
      false,
    ),
    "entityUpward",
  );
  assert.equal(
    violation(
      "apps/web/src/entity/entities.tsx",
      "apps/web/src/features/product/slots",
      true,
    ),
    undefined,
  );
  assert.equal(
    violation(
      "apps/web/src/features/product/slots.tsx",
      "apps/web/src/entity/entities",
      false,
    ),
    undefined,
  );
});

test("specifiers resolve against the alias and the importer", () => {
  assert.equal(
    targetPath(`${S}/domains/wish/repo.ts`, "~/server/db/helpers"),
    `${S}/db/helpers`,
  );
  assert.equal(
    targetPath(`${S}/domains/wish/repo.ts`, "../product/repo/crud"),
    `${S}/domains/product/repo/crud`,
  );
  assert.equal(targetPath(`${S}/domains/wish/repo.ts`, "zod"), undefined);
});
