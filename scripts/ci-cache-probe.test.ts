import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const yaml = require(
  require.resolve("@zkochan/js-yaml", {
    paths: [require.resolve("nx/package.json")],
  }),
);

// Exercise the workflow's real Nx hasher and HTTP cache client. The fake
// external cache stores actual Nx archives; no lane command may run on a probe.
test("CI probe requires a passing archive for the exact inputs, shard and dependency outputs; errors and nightly run lanes", async () => {
  const workflow = yaml.load(readFileSync(".github/workflows/ci.yaml", "utf8"));
  const script = workflow.jobs["cache-probe"].steps.find(
    (step: { id?: string }) => step.id === "probe",
  ).run;
  const root = mkdtempSync(path.join(tmpdir(), "cubby-ci-probe-"));
  const archives = new Map<string, Buffer>();
  let cacheStatus = 200;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    if (request.headers.authorization !== "Bearer synthetic-token") {
      response.writeHead(401).end();
      return;
    }
    if (cacheStatus !== 200) {
      response.writeHead(cacheStatus).end("synthetic cache failure");
      return;
    }
    const key = request.url ?? "";
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      archives.set(key, Buffer.concat(chunks));
      response.end("stored");
    } else {
      const archive = archives.get(key);
      response.writeHead(archive ? 200 : 404).end(archive);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const output = path.join(root, "github-output");
  const cacheUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    CI: "true",
    NX_DAEMON: "false",
    NX_LOAD_DOT_ENV_FILES: "true",
    NX_WORKSPACE_DATA_DIRECTORY: path.join(root, ".nx/workspace-data"),
    NX_SELF_HOSTED_REMOTE_CACHE_SERVER: cacheUrl,
    NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: "synthetic-token",
    NX_SKIP_NX_CACHE: "false",
    GITHUB_OUTPUT: output,
    LANES: JSON.stringify({
      first: {
        projects: ["synthetic"],
        targets: ["test"],
        env: { SHARD: "1/2" },
      },
      second: {
        projects: ["synthetic"],
        targets: ["test"],
        env: { SHARD: "2/2" },
      },
    }),
  };
  let invocation = 0;
  async function run(command: string, extraEnv = {}) {
    const result = await new Promise<{ code: number | null; log: string }>(
      (resolve) => {
        const child = spawn("bash", ["-e", "-c", command], {
          cwd: root,
          env: {
            ...env,
            NX_WORKSPACE_DATA_DIRECTORY: path.join(
              root,
              `.nx/data-${invocation}`,
            ),
            NX_CACHE_DIRECTORY: path.join(root, `.nx/cache-${invocation++}`),
            ...extraEnv,
          },
        });
        let log = "";
        child.stdout.on("data", (chunk) => (log += chunk));
        child.stderr.on("data", (chunk) => (log += chunk));
        child.on("exit", (code) => resolve({ code, log }));
      },
    );
    assert.equal(result.code, 0, result.log);
  }
  async function probe(extraEnv = {}) {
    writeFileSync(output, "");
    await run(script, extraEnv);
    const hits = readFileSync(output, "utf8")
      .trim()
      .replace(/^hits=/, "");
    return JSON.parse(hits);
  }
  try {
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
    writeFileSync(
      path.join(root, "package.json"),
      '{"name":"synthetic","private":true}',
    );
    writeFileSync(
      path.join(root, ".gitignore"),
      "node_modules\n.nx\ngithub-output\nran\nwasm\n",
    );
    writeFileSync(
      path.join(root, "nx.json"),
      JSON.stringify({
        neverConnectToCloud: true,
        namedInputs: {
          gate: ["{workspaceRoot}/**/*", "!{workspaceRoot}/**/*.md"],
        },
      }),
    );
    writeFileSync(
      path.join(root, "project.json"),
      JSON.stringify({
        name: "synthetic",
        targets: {
          wasm: {
            command: "echo ready > wasm",
            outputs: ["{workspaceRoot}/wasm"],
          },
          test: {
            command: "echo ran >> ran",
            cache: true,
            dependsOn: ["wasm"],
            inputs: [
              "gate",
              { env: "SHARD" },
              { dependentTasksOutputFiles: "wasm" },
            ],
          },
        },
      }),
    );
    writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    writeFileSync(path.join(root, "wasm"), "ready\n");
    await run(
      "git init -q && git add . && node node_modules/nx/dist/bin/nx.js run synthetic:test --outputStyle=stream",
      { SHARD: "1/2" },
    );
    assert.ok(archives.size > 0, "Nx must publish a real archive");
    const ran = readFileSync(path.join(root, "ran"), "utf8");
    assert.deepEqual(await probe(), ["first"]);
    writeFileSync(path.join(root, "README.md"), "Documentation-only change\n");
    assert.deepEqual(await probe(), ["first"]);
    writeFileSync(path.join(root, "source.ts"), "export const value = 2;\n");
    assert.deepEqual(await probe(), []);
    writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    writeFileSync(path.join(root, "wasm"), "different bytes\n");
    assert.deepEqual(await probe(), []);
    writeFileSync(path.join(root, "wasm"), "ready\n");
    const [archiveKey, passingArchive] = [...archives.entries()][0];
    // Nx's HTTP writer can encode any exit code; the probe must inspect it
    // even though normal task execution publishes successful results only.
    await run(
      `node <<'NODE'
      const { HttpRemoteCache } = require('nx/src/native');
      new HttpRemoteCache().store(process.env.TEST_HASH, process.env.TEST_STORE_DIRECTORY, 'synthetic failure', 1);
NODE`,
      {
        TEST_HASH: archiveKey.split("/").at(-1),
        TEST_STORE_DIRECTORY: path.join(root, ".nx/cache-0"),
      },
    );
    assert.deepEqual(await probe(), []);
    archives.set(archiveKey, passingArchive);
    cacheStatus = 503;
    assert.deepEqual(await probe(), []);
    cacheStatus = 200;
    assert.deepEqual(
      await probe({ NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: "invalid" }),
      [],
    );
    assert.deepEqual(
      await probe({ NX_SELF_HOSTED_REMOTE_CACHE_SERVER: "" }),
      [],
    );
    const beforeNightly = requests;
    assert.deepEqual(await probe({ NX_SKIP_NX_CACHE: "true" }), []);
    assert.equal(requests, beforeNightly, "nightly must not read the cache");
    for (const key of archives.keys())
      archives.set(key, Buffer.from("invalid archive"));
    assert.deepEqual(await probe(), []);
    assert.equal(
      readFileSync(path.join(root, "ran"), "utf8"),
      ran,
      "probing must never execute the target",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
