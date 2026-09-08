import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

const workflow = readFileSync(".github/workflows/ci.yaml", "utf8");
const playwrightConfig = readFileSync("apps/web/playwright.config.ts", "utf8");

function job(id: string, nextId: string) {
  const start = workflow.indexOf(`  ${id}:\n`);
  const end = workflow.indexOf(`  ${nextId}:\n`, start + 1);
  assert.notEqual(start, -1, `missing ${id} job`);
  assert.notEqual(end, -1, `missing ${nextId} job after ${id}`);
  return workflow.slice(start, end);
}

test("hosted CI is manual and always selects the complete suite", () => {
  const triggers = workflow.slice(0, workflow.indexOf("concurrency:"));
  assert.match(triggers, /workflow_dispatch:/u);
  assert.doesNotMatch(
    triggers,
    /pull_request:|push:|schedule:|bypass_e2e|force_full/u,
  );
  assert.match(triggers, /options: \[verify, coverage\]/u);
  assert.match(job("scope", "validation"), /full: 'true'/u);
  assert.doesNotMatch(workflow, /^  deploy-/mu);
});

test("E2E browser lanes start with scope and test the uploaded artifact", () => {
  const e2e = job("test-e2e", "report-coverage");
  assert.match(e2e, /needs: scope/u);
  assert.doesNotMatch(e2e, /container:/u);
  assert.match(e2e, /lane: chromium[\s\S]*expected-tests: 17/u);
  assert.match(e2e, /lane: webkit[\s\S]*expected-tests: 7/u);
  assert.match(e2e, /Restore exact Playwright browser/u);
  assert.match(e2e, /Bound Ubuntu package mirror retries/u);
  assert.match(
    e2e,
    /Bound Ubuntu package mirror retries\n        if: matrix\.browser == 'webkit'/u,
  );
  assert.match(e2e, /Acquire::http::Timeout "10"/u);
  assert.match(e2e, /\/etc\/apt\/apt-mirrors\.txt/u);
  assert.match(e2e, /Cache Playwright system packages/u);
  assert.match(e2e, /playwright-system-deps-/u);
  assert.match(e2e, /\/var\/cache\/apt\/archives\/\*\.deb/u);
  assert.match(
    e2e,
    /Install Playwright browser dependencies\n        if: matrix\.browser == 'webkit'\n        timeout-minutes: 5/u,
  );
  assert.match(
    e2e,
    /run test:e2e:install-deps -- \$\{\{ matrix\.browser \}\}/u,
  );
  assert.match(
    e2e,
    /run: pnpm --filter @cubby\/web run \$\{\{ matrix\.test-script \}\}/u,
  );
  assert.match(e2e, /Wait for the tested Cloudflare bundle/u);
  assert.match(e2e, /name === "Tests - web \(node\)"/u);
  assert.match(e2e, /name: cf-build/u);
  assert.doesNotMatch(e2e, /pglite/u);
});

test("the node test runner builds and publishes the deployable artifact", () => {
  const web = job("test-web", "test-postgres");
  assert.match(web, /workspace-filter: "@cubby\/web\.\.\."/u);
  assert.match(web, /name: Build web Cloudflare bundle/u);
  assert.match(web, /name: Save Cloudflare bundle/u);
  assert.match(web, /name: cf-build/u);
  assert.ok(
    web.indexOf("name: Build web Cloudflare bundle") <
      web.indexOf("name: Run ${{ matrix.tier }} tests"),
  );
  assert.doesNotMatch(workflow, /^  build-cf:$/mu);
  assert.match(
    web,
    /--project unit --project unit-pure --project mcp-contract/u,
  );
  assert.match(web, /--project ui/u);
});

test("PostgreSQL and browser jobs enforce authoritative counts", () => {
  const postgres = job("test-postgres", "test-aux-coverage");
  const e2e = job("test-e2e", "report-coverage");
  assert.match(postgres, /--project integration/u);
  assert.match(postgres, /export CUBBY_EXPECT_POSTGRES_TESTS=268/u);
  assert.match(postgres, /if \[\[ "\$FULL" == "true" \]\]/u);
  assert.doesNotMatch(postgres, /pglite/u);
  assert.match(e2e, /expected-tests: 17/u);
  assert.match(e2e, /expected-tests: 7/u);
  assert.match(playwrightConfig, /retries: 0/u);
  assert.match(playwrightConfig, /workers: 1/u);
});

test("Playwright package and CI browser cache use the same exact version", () => {
  const webPackage = readFileSync("apps/web/package.json", "utf8");
  const installed = webPackage.match(/"@playwright\/test": "([^"]+)"/u)?.[1];
  const configured = workflow.match(/PLAYWRIGHT_VERSION: "([^"]+)"/u)?.[1];
  assert.equal(configured, installed);
});

test("private-repository runners keep bounded timeout budgets", () => {
  const web = job("test-web", "test-postgres");
  assert.match(web, /args=\("\$\{selected\[@\]\}" --testTimeout=10000/u);
  assert.match(playwrightConfig, /timeout: isCI \? 120_000 : 30_000/u);
});

test("main builds and deploys without rerunning verification", () => {
  const deploy = readFileSync(".github/workflows/deploy.yaml", "utf8");
  assert.match(deploy, /push:\n    branches: \[main\]/u);
  assert.doesNotMatch(
    deploy,
    /pull_request:|test:e2e|pnpm check|test-postgres|test-web/u,
  );
  assert.match(deploy, /classifyPaths\(paths\)/u);
  assert.match(deploy, /needs: scope/u);
  assert.match(deploy, /deploy-cubby-production/u);
  assert.match(deploy, /Re-check current main before deployment/u);
  assert.match(deploy, /run: pnpm --filter @cubby\/web run build:cf/u);
  assert.match(deploy, /deploy --config dist\/server\/wrangler.json/u);
  assert.ok(deploy.indexOf("run build:cf") < deploy.indexOf("deploy --config"));
});

test("manual verification and coverage retain their test tiers", () => {
  for (const [id, nextId] of [
    ["test-rust", "test-web"],
    ["test-web", "test-postgres"],
    ["test-postgres", "test-aux-coverage"],
  ] as const) {
    const verification = job(id, nextId);
    assert.match(verification, /needs\.scope\.outputs\.verify == 'true'/u);
    assert.match(verification, /needs\.scope\.outputs\.coverage == 'true'/u);
  }
});

test("local checks retain every required gate and keep stateful verification live", () => {
  const project = z
    .object({
      targets: z.record(
        z.string(),
        z.object({
          command: z.string(),
          cache: z.boolean(),
          inputs: z
            .array(
              z.union([
                z.string(),
                z.record(
                  z.string(),
                  z.union([z.string(), z.array(z.string())]),
                ),
              ]),
            )
            .optional(),
          outputs: z.array(z.string()).optional(),
        }),
      ),
    })
    .parse(JSON.parse(readFileSync("project.json", "utf8")));
  const manifest = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync("package.json", "utf8")));
  const fast = [
    "entity",
    "start-ops",
    "types",
    "lint",
    "format",
    "soft-delete",
    "identifiers",
    "knip",
  ];
  const extra = ["bindings", "openapi", "script-tests", "security"];
  const commands = {
    entity: "node scripts/entity-literal-generator.ts --check",
    "start-ops": "node scripts/start-operation-registry-generator.ts --check",
    types: "pnpm typecheck",
    lint: "oxlint .",
    format: "oxfmt --check .",
    "soft-delete": "node scripts/check-soft-delete-filters.ts",
    knip: "knip --no-config-hints --cache",
    bindings:
      "pnpm --filter @cubby/web --filter @cubby/upc-lookup --filter @cubby/usda-api --workspace-concurrency=2 types:check",
    openapi: "pnpm --filter @cubby/usda-api generate:openapi:check",
    "script-tests": "pnpm test:scripts",
    security: "pnpm audit:security",
    "fast-tests":
      "pnpm -r --workspace-concurrency=2 test && touch apps/web/.vitest-failures.txt",
    wasm: "pnpm run wasm",
  };
  for (const [name, command] of Object.entries(commands))
    assert.equal(project.targets[name]?.command, command, name);
  assert.match(
    manifest.scripts.check!,
    new RegExp(`--targets=${fast.join(",")}(?: |$)`),
  );
  assert.match(
    manifest.scripts["check:all"]!,
    new RegExp(`--targets=${[...fast, ...extra].join(",")}(?: |$)`),
  );
  assert.equal(
    project.targets.identifiers?.command,
    "node scripts/check-unsafe-identifiers.ts --include-tests && node --test scripts/check-unsafe-identifiers.unit.test.ts",
  );
  for (const name of [
    "soft-delete",
    "security",
    "script-tests",
    "bindings",
    "openapi",
  ])
    assert.equal(project.targets[name]?.cache, false, name);
  assert.equal(manifest.scripts["verify:local"], "node scripts/ci-scope.ts");
  assert.match(manifest.scripts.lint!, /nx run cubby-checks:lint\b/u);
  assert.match(
    manifest.scripts["format:check"]!,
    /nx run cubby-checks:format\b/u,
  );
  assert.equal(manifest.scripts["lint:fix"], "oxlint --fix .");
  assert.equal(manifest.scripts.format, "oxfmt .");
  assert.equal(project.targets.wasm?.cache, true);
  assert.deepEqual(project.targets.wasm?.outputs, [
    "{workspaceRoot}/packages/wasm",
  ]);
  for (const input of [
    "{workspaceRoot}/packages/wasm/package.json",
    "{workspaceRoot}/packages/wasm/.gitignore",
  ])
    assert.ok(project.targets.wasm?.inputs?.includes(input));
  assert.ok(
    project.targets.wasm?.inputs?.some(
      (input) =>
        JSON.stringify(input) ===
        JSON.stringify({
          runtime: "node scripts/ensure-wasm.ts --fingerprint",
        }),
    ),
  );
  assert.ok(
    project.targets.wasm?.inputs?.some(
      (input) =>
        JSON.stringify(input) === JSON.stringify({ externalDependencies: [] }),
    ),
  );
  assert.equal(
    readFileSync(".husky/pre-commit", "utf8").trim().endsWith("pnpm check"),
    true,
  );
  assert.equal(
    readFileSync(".husky/pre-push", "utf8").trim().endsWith("pnpm verify:push"),
    true,
  );
});

test("task caching is bounded and cannot connect to Nx Cloud", () => {
  const config = z
    .object({
      neverConnectToCloud: z.boolean(),
      parallel: z.number(),
      maxCacheSize: z.string(),
    })
    .parse(JSON.parse(readFileSync("nx.json", "utf8")));
  assert.equal(config.neverConnectToCloud, true);
  assert.equal(config.parallel, 2);
  assert.equal(config.maxCacheSize, "2GB");
});
