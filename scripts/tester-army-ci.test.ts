import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifyTesterArmyChanges,
  collectTesterArmyEvidence,
  formatTesterArmySummary,
} from "./lib/tester-army-ci.ts";

test("PR routing ignores prose but covers native, shared and import changes", () => {
  assert.deepEqual(
    classifyTesterArmyChanges(["docs/testing.md", "AGENTS.md"]),
    { web: false, ios: false, imports: false },
  );
  assert.deepEqual(
    classifyTesterArmyChanges(["apps/web/src/components/button.tsx"]),
    { web: true, ios: false, imports: false },
  );
  assert.deepEqual(
    classifyTesterArmyChanges(["apps/apple/Sources/Editor.swift"]),
    { web: true, ios: true, imports: false },
  );
  assert.deepEqual(
    classifyTesterArmyChanges(["packages/schemas/src/product.ts"]),
    { web: true, ios: true, imports: true },
  );
  assert.deepEqual(
    classifyTesterArmyChanges(["apps/web/src/server/services/import.ts"]),
    { web: true, ios: true, imports: true },
  );
  for (const file of [
    "apps/web/src/server/services/product.service.ts",
    "apps/web/src/routes/api/v1/$resource.ts",
    "apps/web/src/contracts/purchase-import.contract.ts",
  ])
    assert.deepEqual(classifyTesterArmyChanges([file]), {
      web: true,
      ios: true,
      imports: true,
    });
  assert.equal(
    classifyTesterArmyChanges([
      "apps/web/src/routes/_authenticated/runs.jobs.$id.tsx",
    ]).imports,
    true,
  );
  assert.deepEqual(classifyTesterArmyChanges(["pnpm-lock.yaml"]), {
    web: true,
    ios: true,
    imports: true,
  });
});

const summary = {
  schemaVersion: 1,
  status: "passed",
  model: "synthetic-model",
  effort: "medium",
  tokens: 1200,
  modelCalls: 4,
  cases: [{ name: "product rename", status: "passed", durationMs: 3000 }],
  replay: { replayed: 1, handedOff: 0, missed: 1 },
};

test("summary cannot report success after startup failure, missing results or a skipped journey", () => {
  const input = {
    lane: "web",
    head: "a".repeat(40),
    runUrl: "https://github.com/example/project/actions/runs/1",
    outcome: "failure",
  };
  assert.match(
    formatTesterArmySummary({ ...input, summaries: [summary] }),
    /failed/,
  );
  assert.match(
    formatTesterArmySummary({ ...input, outcome: "success", summaries: [] }),
    /incomplete/,
  );
  assert.match(
    formatTesterArmySummary({
      ...input,
      outcome: "success",
      summaries: [
        { ...summary, cases: [{ ...summary.cases[0]!, status: "skipped" }] },
      ],
    }),
    /incomplete/,
  );
  const passing = formatTesterArmySummary({
    ...input,
    outcome: "success",
    summaries: [summary],
  });
  assert.match(passing, /passed/);
  assert.match(passing, /Cost: unavailable/);
  assert.match(passing, /3\.0s/);
});

test("summary rejects arbitrary case names and omits model/error content from outward text", () => {
  const body = formatTesterArmySummary({
    lane: "web",
    head: "a".repeat(40),
    runUrl: "https://github.com/example/project/actions/runs/1",
    outcome: "success",
    summaries: [
      {
        ...summary,
        model: "do-not-publish-this-token",
        cases: [{ name: "<script> @someone", status: "passed", durationMs: 3 }],
      },
    ],
  });
  assert.doesNotMatch(body, /do-not-publish-this-token|<script>|@someone/);
});

test("CI evidence retains visuals and sanitized traces but excludes sessions and transcripts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tester-evidence-"));
  try {
    const source = path.join(root, "results");
    const output = path.join(root, "published");
    mkdirSync(path.join(source, "case", "attempt-1", "screenshots"), {
      recursive: true,
    });
    writeFileSync(
      path.join(source, "case", "trace.md"),
      "Bearer synthetic-sensitive-token\nPRD-4K7M\n",
    );
    writeFileSync(
      path.join(source, "case", "attempt-1", "screenshots", "end.png"),
      "synthetic pixels",
    );
    writeFileSync(
      path.join(source, "case", "attempt-1", "video.webm"),
      "synthetic video",
    );
    writeFileSync(path.join(source, "case", "session.json"), "private session");
    mkdirSync(path.join(source, "case", "downloads"));
    writeFileSync(
      path.join(source, "case", "downloads", "private.png"),
      "downloaded file",
    );
    writeFileSync(
      path.join(source, "case", "agent-transcript.txt"),
      "private transcript",
    );
    collectTesterArmyEvidence(source, output, ["synthetic-sensitive-token"]);
    assert.deepEqual(readdirSync(path.join(output, "case")).sort(), [
      "attempt-1",
      "trace.md",
    ]);
    assert.doesNotMatch(
      readFileSync(path.join(output, "case", "trace.md"), "utf8"),
      /synthetic-sensitive-token/,
    );
    assert.equal(
      readFileSync(
        path.join(output, "case", "attempt-1", "screenshots", "end.png"),
        "utf8",
      ),
      "synthetic pixels",
    );
    symlinkSync(
      path.join(root, "private.png"),
      path.join(source, "case", "attempt-1", "screenshots", "escape.png"),
    );
    assert.throws(
      () => collectTesterArmyEvidence(source, output, []),
      /symbolic link/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
