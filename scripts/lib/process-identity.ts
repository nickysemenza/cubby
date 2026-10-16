import { execFileSync } from "node:child_process";

/** Only absence or a different birth in the same format proves death. */
export function processStatus(
  pid: number,
  identity: string | undefined,
): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
      ? "dead"
      : "unknown";
  }
  // Unprefixed identities used the original caller's unknown timezone/locale.
  if (!identity?.startsWith("ps-utc-v1:")) return "unknown";
  const current = processIdentity(pid);
  if (!current) return "unknown";
  return current === identity ? "alive" : "dead";
}

/** Versioned, timezone/locale-independent birth identity; absence is unverifiable. */
export function processIdentity(pid: number): string {
  try {
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return start ? `ps-utc-v1:${start}` : "";
  } catch {
    return "";
  }
}
