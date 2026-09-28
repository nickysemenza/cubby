/**
 * One-shot, pre-migration: move legacy `OrderMailAttachment.pendingDataBase64Url`
 * bytes to object storage under the deterministic key `order-mail-attachment/<id>`
 * and prove every object matches its source row. Run it BEFORE the migration that
 * drops the column: after that the database copy is gone.
 *
 *   pnpm --dir apps/web exec tsx scripts/order-mail-attachments-to-r2.ts \
 *     --database-url "$PRODUCTION_DIRECT_DATABASE_URL"                     # dry run
 *   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *   pnpm --dir apps/web exec tsx scripts/order-mail-attachments-to-r2.ts \
 *     --database-url "$PRODUCTION_DIRECT_DATABASE_URL" \
 *     --r2-endpoint https://<account>.r2.cloudflarestorage.com \
 *     --r2-bucket <bucket> --execute [--manifest ./manifest.jsonl]
 *
 * Configuration is explicit, never ambient: the database comes only from
 * `--database-url` (`DATABASE_URL` is ignored), the endpoint and bucket only from
 * flags, and the credentials from `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
 * (environment, not flags, so they stay out of `ps`). Without `--execute` this
 * is a dry run that prints counts and touches neither storage nor rows.
 *
 * Verification compares sha256 of the bytes read back from storage against
 * sha256 of the bytes decoded from the row. The row's `checksum` column is NOT
 * used: it is a hash of `{sourceKey, dataBase64Url, size}` and neither
 * `sourceKey` nor `size` is stored, so it cannot be recomputed from the row.
 * An object that already exists is skipped only when it verifies; one whose
 * bytes differ is reported and never overwritten. Exit code is non-zero on any
 * mismatch. The script only reads the database; it never writes to it.
 */
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { AwsClient } from "aws4fetch";
import { Pool } from "pg";

export interface AttachmentObjectStore {
  /** `null` when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface Queryable {
  query<Row extends object>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface Mismatch {
  id: string;
  key: string;
  reason: string;
}

export interface MigrationSummary {
  candidates: number;
  totalBytes: number;
  alreadyVerified: number;
  uploaded: number;
  mismatches: Mismatch[];
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const attachmentKey = (id: string) => `order-mail-attachment/${id}`;

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** SigV4 client for R2's S3 API; same URL shape as `server/utils/s3.ts`. */
export function createS3ObjectStore(config: S3Config): AttachmentObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = (key: string) => `${config.endpoint}/${config.bucket}/${key}`;
  return {
    get: async (key) => {
      const response = await client.fetch(url(key));
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `GET ${key}: ${response.status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    put: async (key, bytes, contentType) => {
      const response = await client.fetch(url(key), {
        method: "PUT",
        body: new Uint8Array(bytes),
        headers: { "content-type": contentType },
      });
      if (!response.ok) {
        throw new Error(
          `PUT ${key}: ${response.status} ${response.statusText}`,
        );
      }
    },
  };
}

interface CandidateRow {
  id: string;
  mimeType: string;
  chars: string;
}

/**
 * Migrate every row that still has bytes. One bad object never hides the rest:
 * mismatches accumulate and the caller decides the exit code.
 */
export async function migrateOrderMailAttachments(options: {
  db: Queryable;
  store: AttachmentObjectStore;
  dryRun: boolean;
  onObject?: (entry: {
    id: string;
    key: string;
    sha256: string;
    size: number;
    contentType: string;
  }) => void;
}): Promise<MigrationSummary> {
  const { db, store, dryRun } = options;
  const summary: MigrationSummary = {
    candidates: 0,
    totalBytes: 0,
    alreadyVerified: 0,
    uploaded: 0,
    mismatches: [],
  };
  // Row by row: the whole set is tens of megabytes, but there is no reason to
  // hold it in memory at once.
  const { rows } = await db.query<CandidateRow>(
    `SELECT id, "mimeType", length("pendingDataBase64Url")::text AS chars
       FROM "OrderMailAttachment"
      WHERE "pendingDataBase64Url" IS NOT NULL
      ORDER BY id`,
  );
  summary.candidates = rows.length;
  for (const row of rows) {
    summary.totalBytes += Math.floor((Number(row.chars) * 3) / 4);
  }
  if (dryRun) return summary;

  for (const row of rows) {
    const key = attachmentKey(row.id);
    const {
      rows: [source],
    } = await db.query<{ data: string }>(
      `SELECT "pendingDataBase64Url" AS data FROM "OrderMailAttachment" WHERE id = $1`,
      [row.id],
    );
    if (!source) {
      summary.mismatches.push({ id: row.id, key, reason: "row disappeared" });
      continue;
    }
    // Same decoding the app uses when attaching (`Buffer.from(data, "base64")`
    // accepts the URL-safe alphabet).
    const bytes = new Uint8Array(Buffer.from(source.data, "base64"));
    if (bytes.length === 0) {
      summary.mismatches.push({
        id: row.id,
        key,
        reason: "decoded to 0 bytes",
      });
      continue;
    }
    const expected = sha256(bytes);

    const existing = await store.get(key);
    if (existing) {
      if (sha256(existing) === expected) {
        summary.alreadyVerified += 1;
        options.onObject?.({
          id: row.id,
          key,
          sha256: expected,
          size: bytes.length,
          contentType: row.mimeType,
        });
      } else {
        summary.mismatches.push({
          id: row.id,
          key,
          reason: `existing object sha256 ${sha256(existing)} != row sha256 ${expected}; not overwritten`,
        });
      }
      continue;
    }

    await store.put(key, bytes, row.mimeType);
    const readBack = await store.get(key);
    if (!readBack || sha256(readBack) !== expected) {
      summary.mismatches.push({
        id: row.id,
        key,
        reason: readBack
          ? `readback sha256 ${sha256(readBack)} != row sha256 ${expected}`
          : "object missing after upload",
      });
      continue;
    }
    summary.uploaded += 1;
    options.onObject?.({
      id: row.id,
      key,
      sha256: expected,
      size: bytes.length,
      contentType: row.mimeType,
    });
  }
  return summary;
}

export interface CliConfig {
  databaseUrl: string;
  dryRun: boolean;
  manifest?: string;
  r2?: S3Config;
}

/** `env` is only consulted for the R2 credentials, never for the database. */
export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CliConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "database-url": { type: "string" },
      "r2-endpoint": { type: "string" },
      "r2-bucket": { type: "string" },
      manifest: { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  const databaseUrl = values["database-url"];
  if (!databaseUrl) {
    throw new Error("--database-url is required (DATABASE_URL is ignored)");
  }
  const config: CliConfig = {
    databaseUrl,
    dryRun: !values.execute,
    manifest: values.manifest,
  };
  if (config.dryRun) return config;
  const endpoint = values["r2-endpoint"];
  const bucket = values["r2-bucket"];
  if (!endpoint || !bucket) {
    throw new Error("--execute requires --r2-endpoint and --r2-bucket");
  }
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "--execute requires R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment",
    );
  }
  config.r2 = {
    endpoint: endpoint.replace(/\/+$/u, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
  };
  return config;
}

async function main(): Promise<number> {
  const config = parseCliArgs(process.argv.slice(2), process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'OrderMailAttachment'
            AND column_name = 'pendingDataBase64Url'
       ) AS exists`,
    );
    if (!rows[0]?.exists) {
      console.error(
        'OrderMailAttachment has no "pendingDataBase64Url" column: the migration already ran, so there is nothing to verify.',
      );
      return 1;
    }
    if (config.manifest) writeFileSync(config.manifest, "");
    const summary = await migrateOrderMailAttachments({
      db: pool,
      store: config.r2
        ? createS3ObjectStore(config.r2)
        : {
            get: async () => {
              throw new Error("dry run must not read storage");
            },
            put: async () => {
              throw new Error("dry run must not write storage");
            },
          },
      dryRun: config.dryRun,
      onObject: (entry) => {
        if (config.manifest) {
          appendFileSync(config.manifest, `${JSON.stringify(entry)}\n`);
        }
      },
    });
    console.log(
      `${config.dryRun ? "[dry run] " : ""}rows with bytes: ${summary.candidates} (~${summary.totalBytes} bytes)`,
    );
    if (config.dryRun) {
      console.log("Re-run with --execute to upload and verify.");
      return 0;
    }
    console.log(
      `already verified: ${summary.alreadyVerified}, uploaded and verified: ${summary.uploaded}, mismatches: ${summary.mismatches.length}`,
    );
    for (const mismatch of summary.mismatches) {
      console.error(`MISMATCH ${mismatch.key}: ${mismatch.reason}`);
    }
    return summary.mismatches.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await main().catch((error: Error) => {
    console.error(error.message);
    return 1;
  });
}
