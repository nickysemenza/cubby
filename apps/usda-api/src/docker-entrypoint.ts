#!/usr/bin/env tsx

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface Config {
  dbPath: string;
  dataDir: string;
  r2Bucket?: string;
  r2ObjectKey?: string;
  r2AccountId?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  forceRefresh: boolean;
  downloadQuiet: boolean;
}

class DatabaseManager {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  private async downloadDatabaseWithScript(
    url: string,
    destPath: string
  ): Promise<void> {
    console.log(`[entrypoint] Running optimized download script...`);

    return new Promise((resolve, reject) => {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const scriptPath = path.join(currentDir, "download-database.sh");
      const child = spawn("bash", [scriptPath, url, destPath], {
        stdio: "inherit", // Show script output directly
      });

      child.on("error", (error) => {
        reject(new Error(`Download script failed: ${error.message}`));
      });

      child.on("exit", (code) => {
        if (code === 0) {
          console.log(
            `[entrypoint] Database download pipeline completed successfully`
          );
          resolve();
        } else {
          reject(new Error(`Download script exited with code ${code}`));
        }
      });
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  private formatDuration(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return "calculating...";

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  private getVersionKey(): string | null {
    if (!this.config.r2ObjectKey) return null;
    return this.config.r2ObjectKey.replace(/\.sqlite\.zst$/, ".version");
  }

  private async fetchRemoteVersion(): Promise<string | null> {
    try {
      const versionUrl = "https://usda-sqlite.nickysemenza.com/usda.version";

      const child = spawn(
        "curl",
        ["-s", "--connect-timeout", "2", "--max-time", "3", versionUrl],
        {
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => (stderr += d));

      const code: number = await new Promise((resolve) =>
        child.on("exit", (c) => resolve(c || 0))
      );
      if (code !== 0) return null;
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async getLocalVersion(): Promise<string | null> {
    const localVersionFile = path.join(this.config.dataDir, ".usda.version");
    const version = await this.readFile(localVersionFile);
    return version.trim() || null;
  }

  private async checkNeedDownload(): Promise<boolean> {
    // Force refresh if environment variable is set
    if (this.config.forceRefresh) {
      console.log(
        "[entrypoint] FORCE_DB_REFRESH=1, will download fresh database"
      );
      return true;
    }

    // If database doesn't exist, we need to download
    if (!(await this.fileExists(this.config.dbPath))) {
      console.log(
        "[entrypoint] Database file does not exist, need to download"
      );
      return true;
    }

    // Check for version updates
    if (this.config.r2Bucket && this.config.r2ObjectKey) {
      console.log("[entrypoint] Checking for database updates...");

      const [localVersion, remoteVersion] = await Promise.all([
        this.getLocalVersion(),
        this.fetchRemoteVersion(),
      ]);

      if (!remoteVersion) {
        console.log(
          "[entrypoint] Could not check for updates (version endpoint unavailable)"
        );
        return false;
      }

      if (localVersion !== remoteVersion) {
        console.log(
          `[entrypoint] Database update available (local: ${localVersion || "none"}, remote: ${remoteVersion})`
        );
        return true;
      }

      console.log(
        `[entrypoint] Database is up to date (version: ${localVersion})`
      );
    }

    return false;
  }

  private async saveVersionInfo(): Promise<void> {
    const version = await this.fetchRemoteVersion();
    if (!version) return;

    const localVersionFile = path.join(this.config.dataDir, ".usda.version");
    try {
      await fs.writeFile(localVersionFile, version);
      console.log(
        `[entrypoint] Database downloaded successfully (version: ${version})`
      );
    } catch (error) {
      console.log(
        `[entrypoint] Database downloaded successfully (could not save version: ${error})`
      );
    }
  }

  async downloadDatabase(): Promise<void> {
    if (!this.config.r2Bucket || !this.config.r2ObjectKey) {
      throw new Error(
        `Database not found at ${this.config.dbPath} and R2 bucket/object key not set. ` +
          "Set R2_BUCKET, R2_OBJECT_KEY, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY."
      );
    }

    console.log(
      `[entrypoint] Database missing/outdated; downloading from r2:${this.config.r2Bucket}/${this.config.r2ObjectKey}`
    );

    // Use the optimized bash script for the entire pipeline
    await this.downloadDatabaseWithScript("r2", this.config.dbPath);

    // Save version information
    await this.saveVersionInfo();
  }

  async ensureDatabaseReady(): Promise<void> {
    if (await this.checkNeedDownload()) {
      await this.downloadDatabase();
    } else {
      console.log(`[entrypoint] Database ready at ${this.config.dbPath}`);
    }
  }
}

async function ensureDataDirOwnership(dataDir: string): Promise<void> {
  // Only attempt to change ownership if running as root
  if (process.getuid && process.getuid() === 0) {
    try {
      await fs.chown(dataDir, 1001, 1001);
      console.log(
        `[entrypoint] Changed ownership of ${dataDir} to nodejs user`
      );
    } catch (error) {
      console.log(`[entrypoint] Warning: Could not change ownership: ${error}`);
    }
  }
}

function dropPrivileges(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Only drop privileges if running as root
    if (process.getuid && process.getuid() === 0) {
      console.log(
        "[entrypoint] Dropping privileges to nodejs user (1001:1001)"
      );

      const child = spawn("su-exec", ["1001:1001", ...args], {
        stdio: "inherit",
      });

      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
        } else {
          process.exit(code || 0);
        }
      });

      child.on("error", reject);
    } else {
      // Not running as root, just exec the command directly
      const child = spawn(args[0], args.slice(1), {
        stdio: "inherit",
      });

      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
        } else {
          process.exit(code || 0);
        }
      });

      child.on("error", reject);
    }
  });
}

async function main(): Promise<void> {
  const config: Config = {
    dbPath: process.env.DATABASE_PATH || "/data/usda.sqlite",
    dataDir: "",
    r2Bucket: process.env.R2_BUCKET,
    r2ObjectKey: process.env.R2_OBJECT_KEY,
    r2AccountId: process.env.R2_ACCOUNT_ID,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    forceRefresh: process.env.FORCE_DB_REFRESH === "1",
    downloadQuiet: process.env.DOWNLOAD_QUIET === "1",
  };

  config.dataDir = path.dirname(config.dbPath);

  console.log(`[entrypoint] Using DATABASE_PATH=${config.dbPath}`);

  try {
    // Ensure data directory exists
    await fs.mkdir(config.dataDir, { recursive: true });

    // Initialize database manager and ensure database is ready
    const dbManager = new DatabaseManager(config);
    await dbManager.ensureDatabaseReady();

    // Ensure ownership for WAL/SHM writes
    await ensureDataDirOwnership(config.dataDir);

    // Get command line arguments (skip node and script name)
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.error("[entrypoint] ERROR: No command specified");
      process.exit(1);
    }

    // Drop privileges and exec the main command
    await dropPrivileges(args);
  } catch (error) {
    console.error(`[entrypoint] ERROR: ${error}`);
    process.exit(1);
  }
}

// Handle signals gracefully
process.on("SIGTERM", () => {
  console.log("[entrypoint] Received SIGTERM, exiting gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[entrypoint] Received SIGINT, exiting gracefully...");
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[entrypoint] Fatal error: ${error}`);
    process.exit(1);
  });
}
