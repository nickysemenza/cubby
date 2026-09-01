import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yaml", "utf8");
const playwrightConfig = readFileSync("apps/web/playwright.config.ts", "utf8");

function job(id: string, nextId: string) {
  const start = workflow.indexOf(`  ${id}:\n`);
  const end = workflow.indexOf(`  ${nextId}:\n`, start + 1);
  assert.notEqual(start, -1, `missing ${id} job`);
  assert.notEqual(end, -1, `missing ${nextId} job after ${id}`);
  return workflow.slice(start, end);
}

test("scope releases independent verification lanes without installing dependencies", () => {
  const scope = job("scope", "validation");
  const validation = job("validation", "test-aux");
  const auxiliary = job("test-aux", "test-rust");

  assert.match(scope, /id: scope/u);
  assert.match(scope, /name: Classify changes and find a reusable PR run/u);
  assert.doesNotMatch(scope, /setup-node-with-deps/u);
  assert.doesNotMatch(scope, /pnpm check/u);
  assert.match(validation, /needs: scope/u);
  assert.match(validation, /CHECK_MAX_PROCESSES:/u);
  assert.match(validation, /pnpm check:all &/u);
  assert.match(validation, /wait "\$\{pids\[\$index\]\}"/u);
  assert.doesNotMatch(validation, /--filter '!@cubby\/web'/u);
  assert.match(auxiliary, /needs: scope/u);
  assert.match(auxiliary, /--filter '!@cubby\/web'/u);
  assert.match(scope, /name: Save PR verification provenance/u);
  assert.match(scope, /name: pr-verification-v2-/u);
});

test("ordinary PR verification is reusable only from an exact successful tree", () => {
  const scope = job("scope", "validation");
  assert.match(
    scope,
    /`pr-verification-v2-\$\{pr\.number\}-\$\{pr\.head\.sha\}`/u,
  );
  assert.match(scope, /artifactNames\.has\(verificationArtifact\)/u);
  assert.match(scope, /pr\.merge_commit_sha === context\.sha/u);
  assert.match(scope, /pr\.head\.repo\?\.full_name/u);
  assert.match(
    scope,
    /mainCommit\.data\.tree\.sha === headCommit\.data\.tree\.sha/u,
  );
  assert.match(scope, /run\.conclusion === "success"/u);
  assert.match(scope, /run\.head_sha === pr\.head\.sha/u);
  assert.match(scope, /classified\.web && !artifactNames\.has\("cf-build"\)/u);
  assert.match(scope, /context\.ref === "refs\/heads\/main"/u);
});

test("only the preview label spends a CI runner", () => {
  const scope = job("scope", "validation");
  assert.match(scope, /github\.event\.action != 'labeled'/u);
  assert.match(scope, /github\.event\.label\.name == 'preview'/u);
  assert.match(
    workflow,
    /github\.event\.action == 'labeled' && github\.event\.label\.name \|\| 'verify'/u,
  );
});

test("E2E browser lanes start with scope and test the uploaded artifact", () => {
  const e2e = job("test-e2e", "report-coverage");
  assert.match(e2e, /needs: scope/u);
  assert.doesNotMatch(e2e, /container:/u);
  assert.match(e2e, /lane: chromium[\s\S]*expected-tests: 15/u);
  assert.match(e2e, /lane: webkit[\s\S]*expected-tests: 7/u);
  assert.match(e2e, /Restore exact Playwright browser/u);
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
  assert.match(postgres, /export CUBBY_EXPECT_POSTGRES_TESTS=260/u);
  assert.match(postgres, /if \[\[ "\$FULL" == "true" \]\]/u);
  assert.doesNotMatch(postgres, /pglite/u);
  assert.match(e2e, /expected-tests: 15/u);
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

test("deployment accepts exact PR reuse or every full fallback result", () => {
  const deploy = job("deploy-cf", "deploy-worker");
  assert.match(
    deploy,
    /needs: \[scope, validation, test-aux, test-rust, test-web, test-postgres, test-e2e\]/u,
  );
  for (const result of [
    "needs.scope.result == 'success'",
    "needs.validation.result == 'success'",
    "needs.test-web.result == 'success'",
    "needs.test-postgres.result == 'success'",
    "needs.test-e2e.result == 'success'",
  ]) {
    assert.match(deploy, new RegExp(result.replaceAll(".", "\\."), "u"));
  }
  assert.match(deploy, /needs\.scope\.outputs\.reuse == 'true'/u);
  assert.match(deploy, /needs\.test-aux\.result == 'success'/u);
  assert.match(
    deploy,
    /inputs\.bypass_e2e && needs\.test-e2e\.result == 'skipped'/u,
  );
  assert.doesNotMatch(deploy, /run: pnpm --filter @cubby\/web run build:cf/u);
});

test("reused main runs skip tests while scheduled coverage keeps its tiers", () => {
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
