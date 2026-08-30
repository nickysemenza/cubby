import assert from "node:assert/strict";
import test from "node:test";
import { selectPushChecks } from "./verify-push.ts";

test("documentation-only pushes do not launch code gates", () => {
  assert.deepEqual(selectPushChecks(["docs/ci.md"]), []);
});

test("ordinary web source runs affected tests and the Cloudflare build", () => {
  assert.deepEqual(selectPushChecks(["apps/web/src/lib/date.ts"]), [
    "web-tests",
    "cloudflare",
  ]);
});

test("database changes upgrade affected tests to PostgreSQL", () => {
  assert.deepEqual(
    selectPushChecks(["apps/web/src/server/repo/product/read.ts"]),
    ["postgres", "cloudflare"],
  );
});

test("high-risk and routing changes add browser verification", () => {
  assert.deepEqual(
    selectPushChecks(["apps/web/src/server/repo/inventory/update.ts"]),
    ["postgres", "e2e", "cloudflare"],
  );
  assert.deepEqual(
    selectPushChecks(["apps/web/src/routes/_authenticated/products.tsx"]),
    ["web-tests", "e2e", "cloudflare"],
  );
});

test("unknown paths fail safe across all implementation stacks", () => {
  assert.deepEqual(selectPushChecks(["new-system/config.toml"]), [
    "postgres",
    "e2e",
    "cloudflare",
    "aux",
    "rust",
  ]);
});
