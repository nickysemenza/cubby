import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("workflow routing covers PR changes and labels, skips forks/prose, and selects scheduled/manual lanes without dependencies", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tester-army-ci-"));
  let files: { filename: string; previous_filename?: string }[] = [
    { filename: "apps/web/src/server/services/product.service.ts" },
  ];
  const pull = {
    number: 1,
    state: "open",
    labels: [{ name: "unrelated" }],
    head: { sha: "synthetic-head", repo: { full_name: "example/project" } },
  };
  const server = createServer((request, response) =>
    response.end(
      JSON.stringify(request.url?.includes("/files?") ? files : pull),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const event = {
    action: "labeled",
    number: 1,
    pull_request: {
      labels: [{ name: "unrelated" }],
      head: { repo: { full_name: "example/project" } },
    },
  };
  const env = {
    PATH: process.env.PATH,
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_REPOSITORY: "example/project",
    GITHUB_EVENT_PATH: path.join(root, "event.json"),
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_OUTPUT: path.join(root, "output"),
    GITHUB_TOKEN: "synthetic-token",
    TESTER_ARMY_JOURNEY: "tester-army-pr",
    TESTER_ARMY_PULL_REQUEST: "1",
    TESTER_ARMY_REVISION: "synthetic-head",
  };
  async function run() {
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
    writeFileSync(env.GITHUB_OUTPUT, "");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["ci.ts", "route"], {
        cwd: root,
        env,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
    });
    return readFileSync(env.GITHUB_OUTPUT, "utf8");
  }
  try {
    copyFileSync("scripts/tester-army-ci.ts", path.join(root, "ci.ts"));
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const all = await run();
    assert.match(all, /web=true\nios=false\nimports=true\nsimulator=false/);
    assert.match(
      all,
      /web-matrix=.*product-rename,receive-purchase,field-product-tags.*"lane":"import"/,
    );
    pull.state = "closed";
    assert.match(await run(), /web=false\nios=false\nimports=false/);
    pull.state = "open";
    pull.head.sha = "new-head";
    assert.match(await run(), /web=false\nios=false\nimports=false/);
    pull.head.sha = "synthetic-head";
    files = [
      { filename: "apps/web/src/routes/_authenticated/runs.jobs.$id.tsx" },
    ];
    assert.match(await run(), /imports=true/);
    files = [
      {
        filename: "docs/testing.md",
        previous_filename: "apps/web/src/contracts/purchase-import.contract.ts",
      },
    ];
    assert.match(await run(), /ios=false\nimports=true/);
    files = [{ filename: "docs/testing.md" }];
    assert.match(await run(), /web=false\nios=false\nimports=false/);
    pull.labels = [{ name: "tester-army:ios" }];
    assert.match(await run(), /web=false\nios=true\nimports=false/);
    pull.head.repo.full_name = "example/fork";
    assert.match(await run(), /ios=false/);
    env.GITHUB_EVENT_NAME = "pull_request";
    event.action = "closed";
    assert.match(await run(), /web=false\nios=false\nimports=false/);
    env.GITHUB_EVENT_NAME = "schedule";
    assert.match(await run(), /web=true\nios=true\nimports=true/);
    env.GITHUB_EVENT_NAME = "workflow_dispatch";
    env.TESTER_ARMY_JOURNEY = "tester-army-both";
    assert.match(await run(), /web=true\nios=true\nimports=false/);
    env.TESTER_ARMY_JOURNEY = "simulator-inputs";
    assert.match(await run(), /imports=false\nsimulator=true/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI completion dispatches an open current same-repository PR and accepts GitHub's empty response", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tester-army-dispatch-"));
  const pull = {
    number: 1,
    state: "open",
    head: { sha: "synthetic-head", repo: { full_name: "example/project" } },
  };
  const jobs = [
    "Scope",
    "Validation",
    "Auxiliary tests and builds",
    "Rust - recipebridge and cubby-ffi",
    "Web checks",
    "Apple checks",
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  jobs.push({
    name: "E2E tests (purchase import agent, optional)",
    status: "completed",
    conclusion: "failure",
  });
  let dispatches = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      dispatches++;
      response.writeHead(204).end();
    } else if (request.url?.includes("/jobs?")) {
      response.end(JSON.stringify({ jobs, total_count: jobs.length }));
    } else response.end(JSON.stringify([pull]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const event = {
    repository: { owner: { login: "example" }, default_branch: "main" },
    workflow_run: {
      id: 42,
      status: "completed",
      event: "pull_request",
      conclusion: "failure",
      head_branch: "synthetic-branch",
      head_sha: "synthetic-head",
      head_repository: { full_name: "example/project" },
    },
  };
  try {
    copyFileSync("scripts/tester-army-ci.ts", path.join(root, "ci.ts"));
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const eventPath = path.join(root, "event.json");
    async function run() {
      writeFileSync(eventPath, JSON.stringify(event));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["ci.ts", "dispatch"], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "example/project",
            GITHUB_API_URL: apiUrl,
            GITHUB_TOKEN: "synthetic",
          },
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(stderr)),
        );
      });
    }
    await run();
    assert.equal(dispatches, 1);
    const requiredJob = jobs[1];
    assert(requiredJob);
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      requiredJob.conclusion = conclusion;
      await run();
      assert.equal(dispatches, 1);
    }
    requiredJob.conclusion = "success";
    requiredJob.status = "in_progress";
    await run();
    assert.equal(dispatches, 1);
    requiredJob.status = "completed";
    jobs.splice(1, 1);
    await run();
    assert.equal(dispatches, 1);
    jobs.splice(1, 0, requiredJob);
    pull.state = "closed";
    await run();
    pull.state = "open";
    pull.head.sha = "new-head";
    await run();
    pull.head.sha = "synthetic-head";
    pull.head.repo.full_name = "example/fork";
    await run();
    assert.equal(dispatches, 1);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
