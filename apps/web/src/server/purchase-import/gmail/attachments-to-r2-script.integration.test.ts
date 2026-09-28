import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";
import { createE2EObjectStorage } from "tooling/local-object-storage";
/**
 * The cutover script that moves legacy base64 attachment bytes to object storage.
 *
 * Failure modes these scenarios guard (the script runs once, before the
 * migration drops the only copy of the bytes):
 * - a dry run touches storage or the database;
 * - an object is treated as migrated without its bytes being compared to the
 *   database copy (verification by existence only);
 * - an existing object with different bytes is silently overwritten or accepted;
 * - a store that acknowledges a PUT but returns other bytes is not detected;
 * - a rerun re-uploads verified objects (not idempotent);
 * - the database is chosen implicitly from `DATABASE_URL`.
 *
 * The database is an IntegreSQL clone with the legacy column added back; storage
 * is the repo's local S3-compatible server signed through the script's client.
 */
import { withTestDb } from "tooling/test-setup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { orderMail, orderMailAttachment } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  createS3ObjectStore,
  migrateOrderMailAttachments,
  parseCliArgs,
  type AttachmentObjectStore,
} from "../../../../scripts/order-mail-attachments-to-r2";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../../../scripts/order-mail-attachments-to-r2.ts",
);

const TSX_PATH = path.resolve(
  import.meta.dirname,
  "../../../../node_modules/.bin/tsx",
);

const BYTES = [
  Buffer.from("%PDF-1.4 synthetic invoice one"),
  Buffer.from("%PDF-1.4 synthetic invoice two ÿ\u0001"),
];

describe("order-mail-attachments-to-r2 script", () => {
  const ctx = withTestDb();
  let storage: Awaited<ReturnType<typeof createE2EObjectStorage>>;
  let store: AttachmentObjectStore;
  let pool: Pool;

  beforeAll(async () => {
    storage = await createE2EObjectStorage();
    store = createS3ObjectStore({
      endpoint: storage.url,
      bucket: "e2e-bucket",
      accessKeyId: "synthetic-access-key",
      secretAccessKey: "synthetic-secret-key",
    });
  });
  afterAll(async () => {
    await storage.close();
  });

  /** Rebuild the pre-migration shape and seed two legacy attachments. */
  async function seedLegacyRows() {
    pool = new Pool({ connectionString: ctx.databaseUrl });
    await pool.query(
      `ALTER TABLE "OrderMailAttachment" ADD COLUMN IF NOT EXISTS "pendingDataBase64Url" text`,
    );
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Script member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        messageId: "script-msg",
        sender: "orders@forgewear.example",
        subject: "Receipt",
        receivedAt: new Date("2026-09-01T00:00:00.000Z"),
        rawChecksum: "raw",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: mail not inserted");
    const ids: string[] = [];
    for (const [index, bytes] of BYTES.entries()) {
      const [row] = await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: mail.id,
          providerAttachmentId: `att-${index}`,
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          checksum: `envelope-${index}`,
        })
        .returning({ id: orderMailAttachment.id });
      if (!row) throw new Error("test setup: attachment not inserted");
      await pool.query(
        `UPDATE "OrderMailAttachment" SET "pendingDataBase64Url" = $1 WHERE id = $2`,
        [bytes.toString("base64url"), row.id],
      );
      ids.push(row.id);
    }
    return ids;
  }

  const run = (options: { dryRun: boolean; store?: AttachmentObjectStore }) =>
    migrateOrderMailAttachments({
      db: pool,
      store: options.store ?? store,
      dryRun: options.dryRun,
    });

  it("dry run reports counts and touches neither storage nor rows", async () => {
    const ids = await seedLegacyRows();
    const summary = await run({
      dryRun: true,
      store: {
        get: async () => {
          throw new Error("dry run must not read storage");
        },
        put: async () => {
          throw new Error("dry run must not write storage");
        },
      },
    });

    expect(summary).toMatchObject({
      candidates: 2,
      uploaded: 0,
      mismatches: [],
    });
    expect(await store.get(`order-mail-attachment/${ids[0]}`)).toBeNull();
    await pool.end();
  });

  it("uploads each row to its deterministic key, verifies the readback, and is idempotent", async () => {
    const ids = await seedLegacyRows();

    const first = await run({ dryRun: false });
    expect(first).toMatchObject({
      candidates: 2,
      uploaded: 2,
      alreadyVerified: 0,
      mismatches: [],
    });
    for (const [index, id] of ids.entries()) {
      const object = await store.get(`order-mail-attachment/${id}`);
      expect(Buffer.from(object ?? []).equals(BYTES[index]!)).toBe(true);
    }

    const second = await run({ dryRun: false });
    expect(second).toMatchObject({
      uploaded: 0,
      alreadyVerified: 2,
      mismatches: [],
    });
    await pool.end();
  });

  it("fails on, and does not overwrite, an existing object whose bytes differ", async () => {
    const ids = await seedLegacyRows();
    const key = `order-mail-attachment/${ids[0]}`;
    await store.put(key, Buffer.from("different bytes"), "application/pdf");

    const summary = await run({ dryRun: false });

    expect(summary.mismatches.map((m) => m.key)).toEqual([key]);
    expect(Buffer.from((await store.get(key)) ?? []).toString()).toBe(
      "different bytes",
    );
    // The healthy row is still migrated: one bad object does not hide the rest.
    expect(summary.uploaded).toBe(1);
    await pool.end();
  });

  it("detects a store that acknowledges a PUT but returns other bytes", async () => {
    await seedLegacyRows();
    const corrupting: AttachmentObjectStore = {
      get: store.get,
      put: async (key, bytes, contentType) =>
        store.put(key, Buffer.concat([bytes, Buffer.from("!")]), contentType),
    };

    const summary = await run({ dryRun: false, store: corrupting });

    expect(summary.mismatches).toHaveLength(2);
    expect(summary.uploaded).toBe(0);
    await pool.end();
  });

  it("exits 0 on a verified run and non-zero on a mismatch through the real CLI", async () => {
    const ids = await seedLegacyRows();
    const invoke = async (extra: string[]) => {
      try {
        const { stdout } = await execFileAsync(
          TSX_PATH,
          [
            SCRIPT_PATH,
            "--database-url",
            ctx.databaseUrl,
            "--r2-endpoint",
            storage.url,
            "--r2-bucket",
            "e2e-bucket",
            ...extra,
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: "postgresql://ignored.invalid/none",
              R2_ACCESS_KEY_ID: "synthetic-access-key",
              R2_SECRET_ACCESS_KEY: "synthetic-secret-key",
            },
          },
        );
        return { code: 0, stdout };
      } catch (error) {
        const failure = z
          .object({ code: z.number(), stdout: z.string() })
          .parse(error);
        return { code: failure.code, stdout: failure.stdout };
      }
    };

    const dry = await invoke([]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("[dry run] rows with bytes: 2");

    const executed = await invoke(["--execute"]);
    expect(executed.code).toBe(0);
    expect(executed.stdout).toContain("uploaded and verified: 2");

    await store.put(
      `order-mail-attachment/${ids[1]}`,
      Buffer.from("tampered"),
      "application/pdf",
    );
    expect((await invoke(["--execute"])).code).toBe(1);
    await pool.end();
  });

  it("refuses to pick a database implicitly from DATABASE_URL", () => {
    expect(() =>
      parseCliArgs([], { DATABASE_URL: "postgresql://ignored" }),
    ).toThrow(/--database-url/);
    expect(
      parseCliArgs(["--database-url", "postgresql://explicit"], {}),
    ).toMatchObject({ databaseUrl: "postgresql://explicit", dryRun: true });
    expect(() =>
      parseCliArgs(
        ["--database-url", "postgresql://explicit", "--execute"],
        {},
      ),
    ).toThrow(/--r2-endpoint/);
  });
});
