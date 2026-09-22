import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Low-level `container` CLI wrapper shared by scripts/test-services.ts
 * (ephemeral, per-run containers) and scripts/dev-db.ts (a persistent,
 * fixed-name container). Keep this module free of any run-specific lifecycle
 * policy (naming, cleanup-on-exit) — that belongs in the caller.
 */

export interface ContainerListEntry {
  id: string;
  status: { state: string };
}

/** Run a `container` subcommand and resolve with trimmed stdout, or reject on non-zero exit. */
export function containerCli(
  args: string[],
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process_ = spawn("container", args, {
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      process_.kill("SIGKILL");
      reject(new Error(`container ${args[0]} timed out after ${timeout}ms`));
    }, timeout);
    timer.unref();
    process_.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
    });
    process_.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr = (stderr + data).slice(-64_000);
    });
    process_.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process_.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`container ${args.join(" ")} exited ${code}: ${stderr}`),
        );
    });
  });
}

async function listContainers(): Promise<ContainerListEntry[]> {
  const raw = JSON.parse(
    await containerCli(["list", "--all", "--format", "json"]),
  );
  if (!Array.isArray(raw)) throw new Error("Invalid container list response");
  return raw;
}

export async function findContainer(
  name: string,
): Promise<ContainerListEntry | undefined> {
  return (await listContainers()).find((entry) => entry.id === name);
}

/** `container run --detach --rm ...`. Resolves once the create RPC completes. */
export async function runDetached(
  name: string,
  args: string[],
  { rm = true }: { rm?: boolean } = {},
): Promise<void> {
  await containerCli(
    [
      "run",
      "--detach",
      ...(rm ? ["--rm"] : []),
      "--platform",
      "linux/arm64",
      "--name",
      name,
      ...args,
    ],
    180_000,
  );
}

export async function containerAddress(name: string): Promise<string> {
  const info = JSON.parse(await containerCli(["inspect", name]));
  const ip =
    String(info[0]?.status?.networks?.[0]?.ipv4Address ?? "").split("/")[0] ??
    "";
  if (isIP(ip) !== 4) throw new Error(`No IPv4 address for ${name}`);
  return ip;
}

export async function stopAndRemove(
  name: string,
  { logsOnFailure = false } = {},
): Promise<void> {
  const current = await findContainer(name);
  if (!current) return;
  if (logsOnFailure) {
    console.error(
      `[apple-container] Logs: ${name}\n${await containerCli(["logs", name]).catch(String)}`,
    );
  }
  if (current.status.state === "running")
    await containerCli(["stop", "--time", "5", name]);
  const remaining = await listContainers();
  if (remaining.some((entry) => entry.id === name))
    await containerCli(["delete", name]);
}

export async function waitFor(
  label: string,
  probe: () => Promise<string | void>,
  {
    timeoutMs = 60_000,
    intervalMs = 200,
    aborted = () => false,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    aborted?: () => boolean;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    if (aborted()) throw new Error(`${label} wait aborted`);
    try {
      await probe();
      return;
    } catch (error) {
      failure = error;
      await delay(intervalMs);
    }
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: failure });
}

/** Any HTTP response establishes reachability; callers validate their own API separately. */
export async function httpReady(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  await response.body?.cancel();
}

/**
 * TCP-connect readiness check for PostgreSQL, without shelling into the
 * container. Faster than polling `container exec pg_isready` because it skips
 * the CLI's exec-RPC round trip on every attempt.
 */
export async function tcpReady(host: string, port: number): Promise<void> {
  const { Socket } = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(1_000, () =>
      onError(new Error(`TCP connect to ${host}:${port} timed out`)),
    );
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.connect(port, host);
  });
}
