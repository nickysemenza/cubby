import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

// The low-level migration launcher must reject inherited production targets
// before invoking a container command, just as the development supervisor does.
test("low-level database tools validate inherited database overrides", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "dev-db.ts"), "--unknown"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "postgresql://synthetic:synthetic@db.example.test/cubby",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing inherited DATABASE_URL/u);
  assert.doesNotMatch(result.stderr, /Usage:/u);
});
