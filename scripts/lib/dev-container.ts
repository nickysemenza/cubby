import { z } from "zod";
import {
  containerCli as appleCli,
  type ContainerListEntry,
} from "./apple-container.ts";
import { spawnToExit } from "./run.ts";

export function devContainerBackend(
  env = process.env,
  platform = process.platform,
): "apple" | "docker" {
  const selected =
    env.CUBBY_DEV_SERVICES ?? (platform === "darwin" ? "apple" : "docker");
  if (selected !== "apple" && selected !== "docker")
    throw new Error("CUBBY_DEV_SERVICES must be apple or docker");
  if (selected === "apple" && platform !== "darwin")
    throw new Error(
      "Apple container needs macOS; use CUBBY_DEV_SERVICES=docker",
    );
  return selected;
}

const dockerInspection = z.array(
  z.object({
    Name: z.string(),
    State: z.object({ Status: z.string() }),
    Config: z.object({
      Image: z.string(),
      Env: z.array(z.string()).nullable(),
    }),
    Mounts: z.array(
      z.object({
        Type: z.string(),
        Name: z.string().optional(),
        Destination: z.string(),
      }),
    ),
    NetworkSettings: z.object({
      Ports: z.record(
        z.string(),
        z
          .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
          .nullable(),
      ),
    }),
  }),
);

async function docker(args: string[], timeout: number): Promise<string> {
  let stdout = "";
  let stderr = "";
  const status = await spawnToExit("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    onSpawn(child) {
      child.stdout!.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr!.setEncoding("utf8").on("data", (data: string) => {
        stderr = (stderr + data).slice(-64_000);
      });
    },
  });
  if (status !== 0)
    throw new Error(`docker ${args[0]} exited ${status}: ${stderr}`);
  return stdout.trim();
}

// Normalize only the metadata the existing dev database identity guard uses.
// The same image, volume and loopback-port checks apply to both runtimes.
export async function devContainerCli(
  args: string[],
  timeout = 30_000,
): Promise<string> {
  if (devContainerBackend() === "apple") return appleCli(args, timeout);
  if (args[0] === "list" || args[0] === "inspect") {
    const ids =
      args[0] === "list"
        ? (await docker(["ps", "--all", "--quiet"], timeout))
            .split(/\s+/)
            .filter(Boolean)
        : args.slice(1);
    if (!ids.length) return "[]";
    const entries = dockerInspection.parse(
      JSON.parse(await docker(["inspect", ...ids], timeout)),
    );
    return JSON.stringify(
      entries.map((entry) => ({
        id: entry.Name.replace(/^\//, ""),
        status: { state: entry.State.Status },
        configuration: {
          image: { reference: entry.Config.Image },
          initProcess: { environment: entry.Config.Env ?? [] },
          mounts: entry.Mounts.map((mount) => ({
            destination: mount.Destination,
            type:
              mount.Type === "volume" ? { volume: { name: mount.Name } } : {},
          })),
          publishedPorts: Object.entries(entry.NetworkSettings.Ports).flatMap(
            ([port, bindings]) =>
              (bindings ?? []).map((binding) => ({
                hostAddress: binding.HostIp,
                hostPort: Number(binding.HostPort),
                containerPort: Number(port.split("/")[0]),
              })),
          ),
        },
      })),
    );
  }
  const translated = [...args];
  if (translated[0] === "delete") translated[0] = "rm";
  if (translated[0] === "run") {
    // Docker can use the host architecture; Apple container runs Linux/arm64.
    const platform = translated.indexOf("--platform");
    if (platform !== -1) translated.splice(platform, 2);
  }
  return docker(translated, timeout);
}

export async function findDevContainer(name: string) {
  const entries: ContainerListEntry[] = JSON.parse(
    await devContainerCli(["list", "--all", "--format", "json"]),
  );
  return entries.find((entry) => entry.id === name);
}

export async function stopDevContainer(name: string): Promise<void> {
  const existing = await findDevContainer(name);
  if (!existing) return;
  if (existing.status.state === "running")
    await devContainerCli(["stop", "--time", "5", name]);
  if (await findDevContainer(name)) await devContainerCli(["delete", name]);
}
