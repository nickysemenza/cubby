import { execFileSync } from "node:child_process";

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
