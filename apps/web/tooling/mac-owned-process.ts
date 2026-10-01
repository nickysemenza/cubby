import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

export type MacProcessExpectation = { executable: string; arguments: string[] };
export type OwnedMacProcess = { pid: number; command: string };
function processes(pid?: number) {
  let output: string;
  try {
    output = execFileSync(
      "ps",
      pid === undefined
        ? ["-axo", "pid=,stat=,command="]
        : ["-p", String(pid), "-o", "pid=,stat=,command="],
      { encoding: "utf8", timeout: pid === undefined ? 1000 : 3000 },
    );
  } catch (error) {
    if (
      pid !== undefined &&
      z
        .object({
          status: z.literal(1),
          stdout: z.literal(""),
          stderr: z.literal(""),
        })
        .safeParse(error).success
    )
      return [];
    throw error;
  }
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/u);
    return match
      ? [{ pid: Number(match[1]), state: match[2]!, command: match[3]! }]
      : [];
  });
}
function matches(command: string, expected: MacProcessExpectation) {
  if (!command.startsWith(`${expected.executable} `)) return false;
  const required = expected.arguments.join(" ");
  const argumentsText = command.slice(expected.executable.length + 1);
  const index = argumentsText.indexOf(required);
  return (
    index >= 0 &&
    (index === 0 || argumentsText[index - 1] === " ") &&
    (index + required.length === argumentsText.length ||
      argumentsText[index + required.length] === " ")
  );
}
function discover(
  expected: MacProcessExpectation,
): OwnedMacProcess | undefined {
  const running = processes();
  const own = running.filter(
    (process) =>
      !process.state.includes("Z") && matches(process.command, expected),
  );
  if (own.length > 1)
    throw new Error(
      "Multiple exact fixture launch processes; ownership cannot be established",
    );
  if (own[0]) return { pid: own[0].pid, command: own[0].command };
  if (
    running.some((process) =>
      process.command.startsWith(`${expected.executable} `),
    )
  )
    throw new Error(
      "Fixture executable is running with different arguments; ownership cannot be established",
    );
}
export async function waitForOwnedMacProcess(
  expected: MacProcessExpectation,
): Promise<OwnedMacProcess> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const own = discover(expected);
    if (own) return own;
    await setTimeout(50);
  }
  throw new Error(
    "Exact fixture launch process was not observed; ownership cannot be established",
  );
}
function inspectOwned(expected: MacProcessExpectation, owner: OwnedMacProcess) {
  const current = processes(owner.pid).find(
    (process) => process.pid === owner.pid,
  );
  if (
    current &&
    !/[ZE]/u.test(current.state) &&
    (current.command !== owner.command || !matches(current.command, expected))
  )
    throw new Error(
      `Fixture PID ${owner.pid} changed ownership (state ${current.state}); refusing process signal and lease release`,
    );
  return current;
}
async function awaitExit(
  expected: MacProcessExpectation,
  owner: OwnedMacProcess,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let changedCommand = false;
  do {
    const current = processes(owner.pid).find(
      (process) => process.pid === owner.pid,
    );
    if (!current) return true;
    // A signalled browser can rewrite argv during graceful shutdown. Observe its exit,
    // but never escalate a signal once exact command ownership has been lost.
    if (
      !/[ZE]/u.test(current.state) &&
      (current.command !== owner.command || !matches(current.command, expected))
    )
      changedCommand = true;
    await setTimeout(50);
  } while (Date.now() < deadline);
  if (
    changedCommand &&
    processes(owner.pid).some((process) => process.pid === owner.pid)
  )
    throw new Error(
      `Fixture PID ${owner.pid} changed ownership while exiting; refusing further signals and lease release`,
    );
  return !inspectOwned(expected, owner);
}
function signalOwned(
  expected: MacProcessExpectation,
  owner: OwnedMacProcess,
  signal: "SIGTERM" | "SIGKILL",
) {
  const current = inspectOwned(expected, owner);
  if (!current || /[ZE]/u.test(current.state)) return false;
  try {
    process.kill(owner.pid, signal);
  } catch (error) {
    if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success)
      throw error;
  }
  return true;
}
/** No AX, bundle-wide quit or global kill: revalidate the exact launched command before each signal and prove PID exit. */
export async function stopOwnedMacProcess(
  expected: MacProcessExpectation,
  owner?: OwnedMacProcess,
  deadlines = { terminateMs: 5000, killMs: 2000 },
) {
  const known = owner ?? discover(expected);
  if (!known) return { pid: null, signals: [], exited: true };
  const signals: string[] = [];
  if (signalOwned(expected, known, "SIGTERM")) signals.push("SIGTERM");
  if (!(await awaitExit(expected, known, deadlines.terminateMs))) {
    if (signalOwned(expected, known, "SIGKILL")) signals.push("SIGKILL");
    if (!(await awaitExit(expected, known, deadlines.killMs)))
      throw new Error(
        `Owned fixture PID ${known.pid} did not exit; retaining the host lease`,
      );
  }
  return { pid: known.pid, signals, exited: true };
}
