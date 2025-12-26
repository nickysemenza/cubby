#!/usr/bin/env tsx

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import ora from "ora";

interface UploadConfig {
  bucket: string;
  objectKey: string; // should end with .sqlite.zst
  dbPath: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

class R2Uploader {
  private config: UploadConfig;
  private verbose: boolean;

  constructor(config: UploadConfig, verbose: boolean = false) {
    this.config = config;
    this.verbose = verbose;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async getFileSize(filePath: string): Promise<number> {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
  }

  private async validateDatabase(): Promise<void> {
    const spinner = ora("Validating database...").start();

    try {
      const size = await this.getFileSize(this.config.dbPath);
      spinner.succeed(`Database validated: ${this.formatBytes(size)}`);
    } catch (error) {
      spinner.fail(`Database validation failed: ${error}`);
      throw error;
    }
  }

  private generateVersion(): string {
    return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  }

  private async run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: "inherit",
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${cmd} exited with code ${code}`)),
      );
    });
  }

  private async runCapture(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<{ stdout: string }> {
    return new Promise<{ stdout: string }>((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code) =>
        code === 0
          ? resolve({ stdout })
          : reject(new Error(`${cmd} exited with code ${code}: ${stderr}`)),
      );
    });
  }

  private async compressWithZstd(inputPath: string): Promise<string> {
    const spinner = ora("Compressing database with zstd (smaller)...").start();
    try {
      const outPath = `${inputPath}.zst`;
      await this.run("zstd", ["-12", "-T0", "-f", "-o", outPath, inputPath]);
      const size = await this.getFileSize(outPath);
      spinner.succeed(`Compressed to ${this.formatBytes(size)} (zstd)`);
      return outPath;
    } catch (error) {
      spinner.fail(`zstd compression failed: ${error}`);
      throw error;
    }
  }

  private async writeSha256(filePath: string): Promise<string> {
    const spinner = ora("Generating SHA256 checksum (system tool)...").start();
    try {
      let hashOutput: string;
      try {
        const { stdout } = await this.runCapture("sha256sum", [filePath]);
        hashOutput = stdout.trim();
      } catch {
        const { stdout } = await this.runCapture("shasum", [
          "-a",
          "256",
          filePath,
        ]);
        hashOutput = stdout.trim();
      }
      const hash = hashOutput.split(/\s+/)[0];
      const shaPath = `${filePath}.sha256`;
      await fs.writeFile(shaPath, `${hash}\n`);
      spinner.succeed("Checksum generated");
      return shaPath;
    } catch (error) {
      spinner.fail(`Checksum generation failed: ${error}`);
      throw error;
    }
  }

  private async uploadFileWithRclone(
    localPath: string,
    key: string,
    description: string,
    verbose: boolean = false,
  ): Promise<void> {
    const spinner = ora(`Uploading ${description}...`).start();

    try {
      const size = await this.getFileSize(localPath);
      spinner.text = `Uploading ${description} (${this.formatBytes(size)})...`;

      // Configure rclone environment for R2
      const env = {
        ...process.env,
        RCLONE_CONFIG_R2_TYPE: "s3",
        RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
        RCLONE_CONFIG_R2_ACCESS_KEY_ID: this.config.accessKeyId,
        RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: this.config.secretAccessKey,
        RCLONE_CONFIG_R2_ENDPOINT: `https://${this.config.accountId}.r2.cloudflarestorage.com`,
      };

      const rcloneArgs = [
        "copyto",
        localPath,
        `R2:${this.config.bucket}/${key}`,
        "--transfers=32",
        "--multi-thread-streams=8",
        "--s3-chunk-size=200M",
        "--s3-upload-concurrency=32",
        "--s3-disable-checksum",
        "--progress",
      ];

      if (verbose) {
        rcloneArgs.push("--verbose");
      }

      await new Promise<void>((resolve, reject) => {
        const child = spawn("rclone", rcloneArgs, {
          env,
          stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
        });

        let stderr = "";

        if (!verbose && child.stderr) {
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (data) => {
            stderr += data;
          });
        }

        child.on("error", (error) => {
          reject(new Error(`rclone spawn failed: ${error.message}`));
        });

        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            const errorMsg =
              stderr.trim() || `Process exited with code ${code}`;
            reject(new Error(`rclone failed: ${errorMsg}`));
          }
        });
      });

      spinner.succeed(`Uploaded ${description} (${this.formatBytes(size)})`);
    } catch (error) {
      spinner.fail(`Upload failed for ${description}: ${error}`);
      throw error;
    }
  }

  async uploadDatabase(): Promise<void> {
    console.log("🚀 Starting database upload to Cloudflare R2");
    console.log(`   Database: ${this.config.dbPath}`);
    console.log(`   Bucket: ${this.config.bucket}`);
    console.log(`   Object Key: ${this.config.objectKey}`);
    console.log();

    // Step 1: Verify database file exists
    if (!(await this.fileExists(this.config.dbPath))) {
      throw new Error(`Local database not found: ${this.config.dbPath}`);
    }

    // Enforce compressed artifact naming
    if (!/\.zst$/.test(this.config.objectKey)) {
      throw new Error(
        `R2 object key must end with .zst (got: ${this.config.objectKey}). Set --key to a .zst filename.`,
      );
    }

    const tempFiles: string[] = [];

    try {
      // Step 2: Validate database
      await this.validateDatabase();

      // Step 3: Compress with zstd
      const compressedPath = await this.compressWithZstd(this.config.dbPath);
      tempFiles.push(compressedPath);

      // Step 4: Generate version file
      const version = this.generateVersion();
      const versionPath = `${compressedPath.replace(/\.zst$/, "")}.version`;
      await fs.writeFile(versionPath, version);
      tempFiles.push(versionPath);
      console.log(`✅ Generated version: ${version}`);

      console.log();

      // Step 5: Generate checksum for integrity
      const shaPath = await this.writeSha256(compressedPath);
      tempFiles.push(shaPath);

      // Step 6: Upload files
      const versionKey = this.config.objectKey.replace(
        /\.sqlite\.zst$/,
        ".version",
      );
      const shaKey = `${this.config.objectKey}.sha256`;

      await Promise.all([
        this.uploadFileWithRclone(
          compressedPath,
          this.config.objectKey,
          "compressed database (.zst)",
          this.verbose,
        ),
        this.uploadFileWithRclone(
          versionPath,
          versionKey,
          "version file",
          this.verbose,
        ),
        this.uploadFileWithRclone(
          shaPath,
          shaKey,
          "checksum file",
          this.verbose,
        ),
      ]);

      // Step 7: Display results
      console.log();
      console.log("🎉 Upload complete!");
      console.log();
      console.log("📁 Uploaded to R2:");
      console.log(
        `   Database:  r2:${this.config.bucket}/${this.config.objectKey}`,
      );
      console.log(
        `   Version:   r2:${this.config.bucket}/${versionKey} (${version})`,
      );
      console.log(`   Checksum:  r2:${this.config.bucket}/${shaKey}`);
      console.log();
      console.log(
        "✨ The USDA API will detect new versions in R2 and download + decompress the database.",
      );
    } finally {
      // Clean up temporary files
      await Promise.allSettled(
        tempFiles.map(async (file) => {
          try {
            await fs.unlink(file);
          } catch {
            // Ignore cleanup errors
          }
        }),
      );
    }
  }
}

function validateEnvironment(): UploadConfig {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accountId) {
    throw new Error(
      "R2_ACCOUNT_ID is required (used to construct the S3 endpoint).\n" +
        "Get this from your Cloudflare dashboard.",
    );
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to your R2 access keys.\n" +
        "Create R2 API tokens in your Cloudflare dashboard.",
    );
  }

  return {
    bucket: process.env.R2_BUCKET || "usda-sqlite",
    objectKey: process.env.R2_OBJECT_KEY || "usda.sqlite.zst",
    dbPath: "", // Will be set from command line
    accountId,
    accessKeyId,
    secretAccessKey,
  };
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("upload-db-to-r2")
    .description(
      "Upload SQLite database to Cloudflare R2 with versioning and checksums",
    )
    .argument(
      "[database-path]",
      "Path to the SQLite database file",
      "data/usda.sqlite",
    )
    .option(
      "--bucket <bucket>",
      "R2 bucket name",
      process.env.R2_BUCKET || "usda-sqlite",
    )
    .option(
      "--key <key>",
      "Object key in bucket",
      process.env.R2_OBJECT_KEY || "usda.sqlite.zst",
    )
    .option("--verbose", "Show detailed rclone output for debugging")
    .version("1.0.0")
    .action(async (databasePath, options) => {
      try {
        console.log("📦 USDA Database Uploader");
        console.log("========================");
        console.log();

        const config = validateEnvironment();
        config.dbPath = path.resolve(databasePath);
        config.bucket = options.bucket;
        config.objectKey = options.key;
        // No public base; downloads happen via R2 in the API
        const uploader = new R2Uploader(config, options.verbose);
        await uploader.uploadDatabase();

        console.log();
        console.log("🚨 Next steps:");
        console.log(
          "   1. Ensure your Fly app has R2 envs set: R2_BUCKET, R2_OBJECT_KEY, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
        );
        console.log("   2. Restart your Fly.io app to pick up the changes:");
        console.log("      fly restart");
        console.log();

        process.exit(0);
      } catch (error) {
        console.error(`❌ Error: ${error}`);
        process.exit(1);
      }
    });

  await program.parseAsync();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Fatal error: ${error}`);
    process.exit(1);
  });
}
