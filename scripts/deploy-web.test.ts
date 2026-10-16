import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./deploy-web.sh", import.meta.url);

function release(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cubby-deploy-"));
  const calls = join(directory, "calls");
  writeFileSync(calls, "");
  writeFileSync(
    join(directory, "pnpm"),
    [
      "#!/bin/bash",
      'printf "%s\\n" "$*" >> "$RELEASE_CALLS"',
      'if [[ "$*" == *db:migrate* ]]; then exit "${MIGRATION_STATUS:-0}"; fi',
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "git"),
    '#!/bin/bash\nprintf "%s\\trefs/heads/main\\n" "$CURRENT_MAIN"\n',
    { mode: 0o755 },
  );
  try {
    const result = spawnSync("bash", [script.pathname], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RELEASE_CALLS: calls,
        GITHUB_SHA: "synthetic-release",
        CURRENT_MAIN: "synthetic-release",
        PRODUCTION_DIRECT_DATABASE_URL:
          "postgresql://example:example@database.example.invalid/example",
        PRODUCTION_MIGRATION_THROUGH: "",
        ...overrides,
      },
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a failed migration stops deployment", () => {
  const result = release({ MIGRATION_STATUS: "1" });
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, [
    "--filter @cubby/web db:migrate --target=production",
  ]);
});

test("a staged release migrates only through its boundary before deploying", () => {
  const result = release({ PRODUCTION_MIGRATION_THROUGH: "0001_example" });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [
    "--filter @cubby/web db:migrate --target=production --through=0001_example",
    "--filter @cubby/web exec wrangler deploy --config dist/server/wrangler.json",
  ]);
});

test("a newer main during migration prevents stale code deployment", () => {
  const result = release({ CURRENT_MAIN: "synthetic-successor" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.length, 1);
  assert.match(result.output, /Skipping stale deployment/);
});

test("missing production credentials fail before any release command", () => {
  const result = release({ PRODUCTION_DIRECT_DATABASE_URL: "" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
});
