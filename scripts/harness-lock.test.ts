import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const lockModule = fileURLToPath(
  new URL("lib/harness-lock.ts", import.meta.url),
);
const scratch = mkdtempSync(path.join(tmpdir(), "cubby-harness-lock-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let lockCount = 0;
const freshLockDir = () => path.join(scratch, `lock-${lockCount++}`);

/** A separate process that takes the lock, holds it (until stdin input when `holdMs` < 0), then exits. */
function holder(lockDir: string, holdMs: number, extra = "") {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { acquireHarnessLock } from ${JSON.stringify(lockModule)};
const release = await acquireHarnessLock("synthetic holder", { pollMs: 50, logEveryMs: 100 });
console.log("ACQUIRED " + Date.now());
${extra}
await new Promise((resolve) => ${holdMs} < 0 ? process.stdin.once("data", resolve) : setTimeout(resolve, ${holdMs}));
release();
process.stdin.destroy();
console.log("RELEASED " + Date.now());`,
    ],
    { env: { ...process.env, CUBBY_HARNESS_LOCK_DIR: lockDir } },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  const saw = async (marker: string) => {
    while (!output.includes(marker)) {
      if (child.exitCode !== null && !output.includes(marker))
        throw new Error(`holder exited before ${marker}:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return Number(output.split(`${marker} `)[1]?.split("\n")[0]);
  };
  const logged = async (pattern: RegExp) => {
    while (!pattern.test(output)) {
      if (child.exitCode !== null)
        throw new Error(`holder exited before ${pattern}:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { child, exited, saw, logged, output: () => output };
}

test("a second process queues behind the holder and logs while waiting", async () => {
  const lockDir = freshLockDir();
  const first = holder(lockDir, -1);
  await first.saw("ACQUIRED");
  const second = holder(lockDir, 0);
  await second.logged(/waiting for .*synthetic holder/);
  first.child.stdin.write("release\n");
  const firstReleased = await first.saw("RELEASED");
  const secondAcquired = await second.saw("ACQUIRED");
  assert.ok(secondAcquired >= firstReleased);
  assert.doesNotMatch(second.output(), /reclaimed/);
  assert.equal(await first.exited, 0);
  assert.equal(await second.exited, 0);
  assert.equal(existsSync(lockDir), false);
});

test("a lock whose owner process died is reclaimed", async () => {
  const lockDir = freshLockDir();
  const crashed = holder(lockDir, 60_000);
  await crashed.saw("ACQUIRED");
  crashed.child.kill("SIGKILL");
  await crashed.exited;
  assert.equal(existsSync(lockDir), true);
  const next = holder(lockDir, 0);
  await next.saw("RELEASED");
  assert.equal(await next.exited, 0);
});

test("a child of the holder passes through instead of deadlocking", async () => {
  const lockDir = freshLockDir();
  const parent = holder(
    lockDir,
    0,
    `const { spawnSync } = await import("node:child_process");
const child = spawnSync(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
      `import { acquireHarnessLock } from ${JSON.stringify(lockModule)};
const release = await acquireHarnessLock("synthetic child", { pollMs: 50 });
release();
console.log("CHILD-DONE");`,
    )}], { encoding: "utf8", timeout: 5000 });
console.log(child.stdout.trim());`,
  );
  await parent.saw("RELEASED");
  assert.match(parent.output(), /CHILD-DONE/);
  assert.equal(await parent.exited, 0);
});

test("a process that exits without releasing frees the lock", () => {
  const lockDir = freshLockDir();
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { acquireHarnessLock } from ${JSON.stringify(lockModule)};
await acquireHarnessLock("synthetic forgetful holder");`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CUBBY_HARNESS_LOCK_DIR: lockDir },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(lockDir), false);
});

test("a hand-made lock directory without an owner is waited on, not stolen", async () => {
  const lockDir = freshLockDir();
  mkdirSync(lockDir);
  const waiter = holder(lockDir, 0);
  await waiter.logged(/waiting for .*no owner record/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.doesNotMatch(waiter.output(), /ACQUIRED/);
  rmSync(lockDir, { recursive: true });
  await waiter.saw("RELEASED");
  assert.equal(await waiter.exited, 0);
});
