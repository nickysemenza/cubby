import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
  spawnSync,
} from "node:child_process";

/** Shell-style exit status for a child that ended on a signal. */
const signalStatus = (signal: NodeJS.Signals | null): number =>
  signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;

export interface SpawnToExitOptions extends SpawnOptions {
  /** Called with the live child, so the caller can track it or attach stream handlers. */
  onSpawn?: (child: ChildProcess) => void;
  /** Called once the child has closed, success or not. */
  onClose?: (child: ChildProcess) => void;
}

/**
 * Spawn a child and resolve with its exit status (signals map to the shell's
 * 130/143, anything else to 1). Rejects only if the process cannot start. The
 * single child-process wrapper for scripts and tooling: callers differ in how
 * they treat the status, not in how they wait for it.
 */
export function spawnToExit(
  command: string,
  args: readonly string[],
  { onSpawn, onClose, ...options }: SpawnToExitOptions = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, options);
    onSpawn?.(child);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      onClose?.(child);
      resolve(code ?? signalStatus(signal));
    });
  });
}

/** {@link spawnToExit}, rejecting on a non-zero status with `describe(status)` or a default message. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: SpawnToExitOptions & { describe?: (status: number) => string } = {},
): Promise<void> {
  const { describe, ...spawnOptions } = options;
  const status = await spawnToExit(command, args, spawnOptions);
  if (status !== 0)
    throw new Error(
      describe?.(status) ??
        `${command} ${args[0] ?? ""} exited ${status}`.trim(),
    );
}

/** Synchronous run with inherited stdio; echoes the command and its wall time. */
export function runSyncChecked(
  program: string,
  args: readonly string[],
  cwd: string,
): void {
  process.stdout.write(`$ ${program} ${args.join(" ")}\n`);
  const started = performance.now();
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} exited with status ${result.status}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(`==> ${program} (${seconds}s)\n`);
}

/** Synchronous run returning stdout; failure carries the child's stderr. */
export function captureSyncChecked(
  program: string,
  args: readonly string[],
  cwd: string,
): string {
  const result = spawnSync(program, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${program} ${args.join(" ")} exited with status ${result.status}\n${result.stderr}`,
    );
  return result.stdout;
}
