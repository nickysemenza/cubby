import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  stopOwnedMacProcess,
  waitForOwnedMacProcess,
} from "./mac-owned-process";

const children: ReturnType<typeof spawn>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        child.once("close", resolve);
        child.kill("SIGKILL");
      });
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function fixture(ignoreTermination = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "cubby-owned-process-"));
  directories.push(directory);
  const script = path.join(directory, "fixture.cjs");
  writeFileSync(
    script,
    `${ignoreTermination ? "process.on('SIGTERM',()=>{});" : ""} console.log('ready'); setInterval(()=>{},1000);`,
  );
  const nonce = randomBytes(8).toString("hex");
  const args = [script, nonce];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  return { child, expected: { executable: process.execPath, arguments: args } };
}

describe("runner-owned process cleanup before AX binding", () => {
  it("discovers its exact launch when AX binding never supplied a PID and waits for exit", async () => {
    const { child, expected } = await fixture();
    const result = await stopOwnedMacProcess(expected);
    expect(result.pid).toBe(child.pid);
    expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
  });

  it("does not signal a foreign PID or a process whose exact command changed", async () => {
    const { child, expected } = await fixture();
    const owner = await waitForOwnedMacProcess(expected);
    await expect(
      stopOwnedMacProcess({ ...expected, arguments: ["foreign-run"] }, owner),
    ).rejects.toThrow(/ownership/);
    await expect(
      stopOwnedMacProcess(expected, { ...owner, command: "different launch" }),
    ).rejects.toThrow(/ownership/);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });

  it("awaits owned process exit after bounded escalation instead of resolving at SIGKILL", async () => {
    const { child, expected } = await fixture(true);
    const owner = await waitForOwnedMacProcess(expected);
    const result = await stopOwnedMacProcess(expected, owner, {
      terminateMs: 100,
      killMs: 2000,
    });
    expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
  });
});
