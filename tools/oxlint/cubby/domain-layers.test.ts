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
    undefined,
  );
});

test("platform and generic code never reach a domain's service or operations", () => {
  assert.equal(
    violation(
      `${S}/mcp/tools.ts`,
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
  assert.equal(
    violation(
      `${S}/domains/purchase-import/gmail/server.ts`,
      `${S}/domains/product/service/product.service`,
      false,
    ),
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
