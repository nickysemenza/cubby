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
  const server = createServer((_request, response) =>
    response.end(JSON.stringify(files)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- node:http returns a numeric TCP address or a Unix socket path.
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
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_OUTPUT: path.join(root, "output"),
    GITHUB_TOKEN: "synthetic-token",
    TESTER_ARMY_JOURNEY: "",
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
    assert.match(all, /web=true\nios=true\nimports=true\nsimulator=false/);
    assert.match(all, /web-matrix=.*"lane":"web".*"lane":"import"/);
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
    assert.match(await run(), /ios=true\nimports=true/);
    files = [{ filename: "docs/testing.md" }];
    assert.match(await run(), /web=false\nios=false\nimports=false/);
    event.pull_request.labels = [{ name: "tester-army:ios" }];
    assert.match(await run(), /web=false\nios=true\nimports=false/);
    event.pull_request.head.repo.full_name = "example/fork";
    assert.match(await run(), /ios=false/);
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
