import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runWithTestServices } from "./test-services.ts";
import { testServiceConfig } from "../apps/web/tooling/test-service-config.ts";

// The external CLI is the seam: exercise real subprocesses, exit codes and
// process groups without requiring a privileged VM runtime on CI.
const fakeCLI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const command = args[0];
let output = '';
let code = 0;
if (command === 'run') {
  const id = args[args.indexOf('--name') + 1];
  state.containers.push({ id, status: { state: 'running' } });
  if (id.endsWith(process.env.FAKE_FAIL_AT || 'never')) {
    state.containers.at(-1).status.state = 'stopped';
    code = 1;
  }
} else if (command === 'inspect') {
  output = JSON.stringify([{ status: { networks: [{ ipv4Address: '192.0.2.10/24' }] } }]);
} else if (command === 'list') {
  output = JSON.stringify(state.containers);
} else if (command === 'stop' || command === 'delete') {
  if (process.env.FAKE_FAIL_STOP) code = 1;
  else state.containers = state.containers.filter(c => c.id !== args.at(-1));
} else if (command === 'logs') {
  output = 'fixture service logs';
}
writeFileSync(path, JSON.stringify(state));
console.log(output);
process.exitCode = code;
`;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cubby-services-test-"));
  const statePath = join(dir, "state.json");
  writeFileSync(join(dir, "container"), fakeCLI, { mode: 0o755 });
  writeFileSync(
    statePath,
    JSON.stringify({
      calls: [],
      containers: [{ id: "another-worktree", status: { state: "running" } }],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("", { status: 404 }),
  );
  function state(): { calls: string[][]; containers: { id: string }[] } {
    return JSON.parse(readFileSync(statePath, "utf8"));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "",
    CUBBY_TEST_SERVICES: "",
    VITEST_MAX_WORKERS: "6",
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_STATE: statePath,
  };
  return { dir, state, options: { platform: "darwin" as const, env } };
}

const node = (source: string) => [process.execPath, "-e", source];

test("owned services provide endpoints, nested commands reuse them, images need no volumes or host ports", async (t) => {
  const f = fixture(t);
  const resultPath = join(f.dir, "env.json");
  const wrapper = new URL("./test-services.ts", import.meta.url).href;
  const code = await runWithTestServices(
    node(`
    const { runWithTestServices } = await import(${JSON.stringify(wrapper)});
    process.exitCode = await runWithTestServices([process.execPath, '-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(process.env))`)}]);
  `),
    f.options,
  );
  assert.equal(code, 0);
  const env = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(env.INTEGRESQL_URL, "http://192.0.2.10:5000");
  assert.equal(env.INTEGRESQL_DATABASE_HOST, "192.0.2.10");
  assert.equal(env.INTEGRESQL_DATABASE_PORT, "5432");
  assert.equal(env.VITEST_MAX_WORKERS, "6");
  assert.equal(env.PLAYWRIGHT_HTML_OPEN, "never");
  assert.equal(env.CUBBY_TEST_SERVICES, "external");
  const starts = f.state().calls.filter(([command]) => command === "run");
  assert.equal(starts.length, 2);
  for (const args of starts) {
    assert.ok(args.includes("--rm") && args.includes("--detach"));
    assert.ok(
      !args.includes("--publish") &&
        !args.includes("--volume") &&
        !args.includes("--mount"),
    );
  }
  assert.ok(starts[0]?.includes("PGDATA=/cubby-testdata"));
  assert.deepEqual(
    f.state().containers.map((c) => c.id),
    ["another-worktree"],
  );
});

test("failed tests preserve exit status and collect logs before cleanup", async (t) => {
  const f = fixture(t);
  assert.equal(
    await runWithTestServices(node("process.exit(7)"), f.options),
    7,
  );
  assert.equal(f.state().containers.length, 1);
  const calls = f.state().calls.map(([command]) => command);
  assert.ok(calls.indexOf("logs") < calls.indexOf("stop"));
});

test("partial startup cleans stopped objects and the other running service", async (t) => {
  const f = fixture(t);
  f.options.env = { ...f.options.env, FAKE_FAIL_AT: "integresql" };
  assert.equal(
    await runWithTestServices(node("process.exit(0)"), f.options),
    1,
  );
  assert.equal(f.state().containers.length, 1);
  assert.ok(f.state().calls.some(([command]) => command === "delete"));
});

test("cleanup failures fail an otherwise successful command", async (t) => {
  const f = fixture(t);
  f.options.env = { ...f.options.env, FAKE_FAIL_STOP: "1" };
  assert.equal(
    await runWithTestServices(node("process.exit(0)"), f.options),
    1,
  );
  assert.equal(
    f.state().calls.filter(([command]) => command === "stop").length,
    2,
  );
});

test("external mode, CI and Linux run without any container executable", async () => {
  for (const [platform, extra] of [
    ["darwin", { CUBBY_TEST_SERVICES: "external" }],
    ["darwin", { CI: "true" }],
    ["linux", {}],
  ] as const) {
    assert.equal(
      await runWithTestServices(node("process.exit(3)"), {
        platform,
        env: { PATH: "/nonexistent", ...extra },
      }),
      3,
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `${signal} cleans services and terminates test descendants`,
    { timeout: 15_000 },
    async (t) => {
      const f = fixture(t);
      const pidPath = join(f.dir, "descendant.pid");
      const descendant = `
      process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
      require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
      const command = node(`
      require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
      const nestedWrapper = new URL("./test-services.ts", import.meta.url).href;
      const nested = node(`
        const { runWithTestServices } = await import(${JSON.stringify(nestedWrapper)});
        process.exitCode = await runWithTestServices(${JSON.stringify(command)});
      `);
      const running = runWithTestServices(nested, f.options);
      while (!existsSync(pidPath)) await delay(20);
      process.emit(signal);
      assert.equal(await running, signal === "SIGINT" ? 130 : 143);
      assert.equal(f.state().containers.length, 1);
      const pid = Number(readFileSync(pidPath, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    },
  );
}

test("service config is lazy, preserves external defaults and validates ports", () => {
  assert.deepEqual(testServiceConfig({}), {
    url: "http://localhost:5000",
    host: "localhost",
    port: 5432,
  });
  assert.deepEqual(
    testServiceConfig({
      INTEGRESQL_URL: "http://192.0.2.5:5000/",
      INTEGRESQL_DATABASE_HOST: "192.0.2.6",
      INTEGRESQL_DATABASE_PORT: "5433",
    }),
    { url: "http://192.0.2.5:5000", host: "192.0.2.6", port: 5433 },
  );
  assert.throws(
    () => testServiceConfig({ INTEGRESQL_DATABASE_PORT: "invalid" }),
    /port number/u,
  );
});

test(
  "foreground tracing stays alive until interrupted and cleans its container",
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    const wrapper = new URL("./test-services.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    globalThis.fetch = async () => new Response('');
    const {runWithTestServices} = await import(${JSON.stringify(wrapper)});
    process.exitCode = await runWithTestServices([], {platform:'darwin', tracing:true});
  `,
      ],
      { env: f.options.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      let output = "";
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("Jaeger: http://localhost:16686")) resolve();
        });
        child.once("exit", () =>
          reject(new Error("Tracing exited before readiness")),
        );
      });
      await delay(250);
      assert.equal(
        child.exitCode,
        null,
        "a detached container must not let the foreground wrapper exit",
      );
      child.kill("SIGINT");
      assert.equal(await closed, 130);
      assert.deepEqual(
        f.state().containers.map((c) => c.id),
        ["another-worktree"],
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await closed;
    }
  },
);
