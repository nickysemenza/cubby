import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const [adminURL, databaseName, ownerText, logPath, sessionName, stateDir] =
  process.argv.slice(2);
const ownerPID = Number(ownerText);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const expectedStateDir = path.join(
  repoRoot,
  "artifacts/sim-dev",
  databaseName ?? "",
  "agent-device-state",
);
if (
  adminURL !== "postgresql://postgres:password@localhost:55432/postgres" ||
  !/^cubby_sim_[0-9a-f]{16}$/.test(databaseName ?? "") ||
  !Number.isSafeInteger(ownerPID) ||
  ownerPID <= 0 ||
  !logPath ||
  (sessionName !== undefined &&
    (sessionName !== `cubby-sim-${databaseName}` ||
      stateDir !== expectedStateDir)) ||
  (sessionName === undefined && stateDir !== undefined)
) {
  process.exit(2);
}

const log = (message) => appendFileSync(logPath, `[watchdog] ${message}\n`);
let checking = false;
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    try {
      process.kill(ownerPID, 0);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") return;
    }

    if (sessionName) {
      const closed = spawnSync(
        path.join(repoRoot, "node_modules/.bin/agent-device"),
        [
          "close",
          "--platform",
          "ios",
          "--session",
          sessionName,
          "--state-dir",
          stateDir,
        ],
        { cwd: repoRoot, timeout: 15_000, encoding: "utf8" },
      );
      log(
        `Session cleanup ${sessionName}: ${closed.status === 0 ? "closed" : closed.stderr?.trim() || closed.error || "unavailable"}`,
      );
    }

    const pool = new pg.Pool({ connectionString: adminURL });
    try {
      const result = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
        [databaseName],
      );
      if (result.rows[0]?.present) {
        await pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        log(`Dropped ${databaseName} after owner ${ownerPID} exited`);
      }
      process.exitCode = 0;
      clearInterval(timer);
    } finally {
      await pool.end();
    }
  } catch (error) {
    log(`Cleanup retry for ${databaseName}: ${String(error)}`);
  } finally {
    checking = false;
  }
}, 2000);
