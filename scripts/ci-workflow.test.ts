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

test("preflight classifies and validates in one runner job", () => {
  const preflight = job("preflight", "test-rust");
  assert.match(preflight, /id: scope/u);
  assert.match(preflight, /name: Run repository preflight/u);
  assert.match(preflight, /pnpm check:all &/u);
  assert.match(preflight, /wait "\$\{pids\[\$index\]\}"/u);
  assert.match(preflight, /name: Save PR verification provenance/u);
  assert.match(preflight, /name: pr-verification-v1-/u);
  assert.doesNotMatch(workflow, /^  scope:$/mu);
  assert.doesNotMatch(workflow, /^  full-verification:$/mu);
});

test("ordinary PR verification is reusable without a manual full label", () => {
  const preflight = job("preflight", "test-rust");
  assert.match(preflight, /name: Classify changes and find a reusable PR run/u);
  assert.match(
    preflight,
    /`pr-verification-v1-\$\{pr\.number\}-\$\{pr\.head\.sha\}`/u,
  );
  assert.match(preflight, /artifactNames\.has\(verificationArtifact\)/u);
  assert.match(preflight, /pr\.merge_commit_sha === context\.sha/u);
  assert.match(preflight, /pr\.head\.repo\?\.full_name/u);
  assert.match(
    preflight,
    /mainCommit\.data\.tree\.sha === headCommit\.data\.tree\.sha/u,
  );
  assert.match(preflight, /run\.conclusion === "success"/u);
  assert.match(preflight, /run\.head_sha === pr\.head\.sha/u);
  assert.match(
    preflight,
    /classified\.web && !artifactNames\.has\("cf-build"\)/u,
  );
  assert.match(preflight, /context\.ref === "refs\/heads\/main"/u);
  assert.doesNotMatch(preflight, /labels\.includes\("ci:full"\)/u);
  assert.doesNotMatch(workflow, /\blabeled, unlabeled\b/u);
});

test("only the preview label spends a CI runner", () => {
  const preflight = job("preflight", "test-rust");
  assert.match(preflight, /github\.event\.action != 'labeled'/u);
  assert.match(preflight, /github\.event\.label\.name == 'preview'/u);
  assert.match(
    workflow,
    /github\.event\.action == 'labeled' && github\.event\.label\.name \|\| 'verify'/u,
  );
});

test("E2E setup overlaps the build but tests the uploaded artifact", () => {
  const e2e = job("test-e2e", "report-coverage");
  assert.match(e2e, /needs: preflight/u);
  assert.doesNotMatch(e2e, /needs:.*build-cf/u);
  assert.match(e2e, /needs\.preflight\.outputs\.verify == 'true'/u);
  assert.match(e2e, /Wait for the tested Cloudflare bundle/u);
  assert.match(e2e, /name === "Tests - web \(node\)"/u);
  assert.match(e2e, /Cloudflare build ended/u);
  assert.match(e2e, /twenty minutes/u);
  assert.match(e2e, /name: cf-build/u);
  assert.match(e2e, /run: pnpm --filter @cubby\/web run test:e2e:postgres/u);
});

test("the node test runner builds and publishes the deployable artifact", () => {
  const web = job("test-web", "test-postgres");
  assert.match(web, /workspace-filter: "@cubby\/web\.\.\."/u);
  assert.match(web, /name: Build web Cloudflare bundle/u);
  assert.match(web, /name: Save Cloudflare bundle/u);
  assert.match(web, /name: cf-build/u);
  assert.match(web, /matrix\.tier == 'node'/u);
  assert.ok(
    web.indexOf("name: Build web Cloudflare bundle") <
      web.indexOf("name: Run ${{ matrix.tier }} tests"),
  );
  assert.doesNotMatch(workflow, /^  build-cf:$/mu);
});

test("private-repository runners get timeout budgets for their lower CPU tier", () => {
  const web = job("test-web", "test-postgres");
  assert.match(web, /args=\("\$\{selected\[@\]\}" --testTimeout=10000/u);
  assert.match(playwrightConfig, /timeout: isCI \? 120_000 : 30_000/u);
});

test("deployment accepts exact PR reuse or every full fallback result", () => {
  const deploy = job("deploy-cf", "deploy-worker");
  assert.match(
    deploy,
    /needs: \[preflight, test-rust, test-web, test-postgres, test-e2e\]/u,
  );
  for (const result of [
    "needs.preflight.result == 'success'",
    "needs.test-web.result == 'success'",
    "needs.test-postgres.result == 'success'",
    "needs.test-e2e.result == 'success'",
  ]) {
    assert.match(deploy, new RegExp(result.replaceAll(".", "\\."), "u"));
  }
  assert.match(deploy, /needs\.preflight\.outputs\.reuse == 'true'/u);
  assert.match(
    deploy,
    /inputs\.bypass_e2e && needs\.test-e2e\.result == 'skipped'/u,
  );
  assert.match(deploy, /uses: \.\/\.github\/actions\/setup-node-with-deps/u);
  assert.match(deploy, /workspace-filter: "@cubby\/web\.\.\."/u);
  assert.match(deploy, /cache-pnpm-store: "false"/u);
  assert.ok(
    deploy.indexOf("uses: ./.github/actions/setup-node-with-deps") <
      deploy.indexOf("uses: cloudflare/wrangler-action"),
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
    assert.match(verification, /needs\.preflight\.outputs\.verify == 'true'/u);
    assert.match(
      verification,
      /needs\.preflight\.outputs\.coverage == 'true'/u,
    );
  }
});
