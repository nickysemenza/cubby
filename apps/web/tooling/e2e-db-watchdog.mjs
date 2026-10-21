import { appendFileSync } from "node:fs";
import pg from "pg";

const [adminURL, databaseName, ownerText, logPath] = process.argv.slice(2);
const ownerPID = Number(ownerText);
if (
  adminURL !== "postgresql://postgres:password@localhost:55432/postgres" ||
  !/^cubby_sim_[0-9a-f]{16}$/.test(databaseName ?? "") ||
  !Number.isSafeInteger(ownerPID) ||
  ownerPID <= 0 ||
  !logPath
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
