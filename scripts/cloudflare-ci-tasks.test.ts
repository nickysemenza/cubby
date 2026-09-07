import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { commandRunner } from "./cloudflare-ci-runtime.ts";
import { pilotCommands, runPilotCommands } from "./cloudflare-ci-tasks.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cubby-pilot-tasks-"));
  const script = join(root, "child.mjs");
  await writeFile(
    script,
    `
    import { writeFile, access } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const [mode, own, peer] = process.argv.slice(2);
    await writeFile(own, String(process.pid));
    if (peer) {
      const end = Date.now() + 5000;
      while (!(await access(peer).then(() => true, () => false))) {
        if (Date.now() > end) throw Error('peer never started');
        await delay(10);
      }
    }
    if (mode === 'fail') process.exit(17);
    if (mode === 'wait') setInterval(() => {}, 1000);
  `,
  );
  return {
    root,
    command: (mode: string, name: string, peer?: string) =>
      [
        process.execPath,
        script,
        mode,
        join(root, name),
        ...(peer ? [join(root, peer)] : []),
      ]
        .map(quote)
        .join(" "),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}

test("both lanes overlap and a failure stops its running peer", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runPilotCommands(
        [
          { name: "failure", command: f.command("fail", "failure", "peer") },
          { name: "peer", command: f.command("wait", "peer", "failure") },
        ],
        2,
      ),
      /Pilot task group failed/,
    );
    const pid = Number(await readFile(join(f.root, "peer"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await f.clean();
  }
});

test("a lane stops before downstream work after failure", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runPilotCommands(
        [
          { name: "build", command: f.command("fail", "build") },
          { name: "e2e", command: f.command("pass", "e2e") },
        ],
        1,
      ),
      /Pilot task group failed/,
    );
    await assert.rejects(readFile(join(f.root, "e2e")), { code: "ENOENT" });
  } finally {
    await f.clean();
  }
});

test("the pilot deadline stops both npm-managed process trees before cleanup", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const script = join(f.root, "parent.mjs");
  await writeFile(
    script,
    `
    import { runPilotCommands } from ${JSON.stringify(new URL("./cloudflare-ci-tasks.ts", import.meta.url).href)};
    await runPilotCommands(${JSON.stringify([
      { name: "a", command: f.command("wait", "a") },
      { name: "b", command: f.command("wait", "b") },
    ])}, 2);
  `,
  );
  const result = commandRunner({ PATH: process.env.PATH }, controller.signal)(
    process.execPath,
    [script],
    { quiet: true },
  );
  const rejected = assert.rejects(result, /exited/);
  try {
    const end = Date.now() + 5_000;
    for (const name of ["a", "b"]) {
      while (
        !(await readFile(join(f.root, name)).then(
          () => true,
          () => false,
        ))
      ) {
        assert.ok(Date.now() < end, "both process trees must start");
        await delay(10);
      }
    }
    controller.abort();
    await rejected;
    for (const name of ["a", "b"]) {
      const pid = Number(await readFile(join(f.root, name), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  } finally {
    controller.abort();
    await rejected;
    await f.clean();
  }
});

test("full verification preserves build ordering, count guards, and worker caps", () => {
  const web = pilotCommands("web");
  const names = web.map((task) => task.name);
  assert.ok(names.indexOf("web-build") < names.indexOf("browser-tests"));
  assert.ok(names.indexOf("postgres-tests") < names.indexOf("browser-tests"));
  assert.match(JSON.stringify(web), /test:postgres --maxWorkers=2/);
  assert.match(
    JSON.stringify(web),
    /--workspace-concurrency=1 test --maxWorkers=2/,
  );
  assert.match(JSON.stringify(web), /pnpm test:e2e/);
  assert.deepEqual(
    pilotCommands("rust").map((task) => task.name),
    ["rust-fmt", "rust-test", "rust-clippy"],
  );
});
