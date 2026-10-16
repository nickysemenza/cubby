import { fromPartial } from "@total-typescript/shoehorn";
import { setCfEnv } from "../../src/server/cf-env";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, globSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { hashPassword } from "better-auth/crypto";
import {
  cloneSchemaTemplate,
  databaseIdentifier,
  templateClient,
  templateConnectionUrl,
} from "../schema-template";
import { hashSchemaTemplateInputs } from "../schema-template-inputs";
import { seedUpcLookupFixture } from "./upc-fixture";
import { createPostgresPool } from "../postgres-pool";
import {
  assertDevDatabaseUrl,
  DEV_USER_EMAIL,
  DEV_USER_NAME,
  DEV_USER_PASSWORD,
  LOCAL_FIXTURE_VERSION,
} from "./state";

/** Hash all application code that can affect the corpus, not just its entry file. */
export function corpusTemplateHash(): string {
  const hash = createHash("sha1")
    .update(hashSchemaTemplateInputs())
    .update(String(LOCAL_FIXTURE_VERSION));
  for (const file of globSync([
    "tooling/scenarios/**/*.ts",
    "tooling/factories/**/*.ts",
    "tooling/dev/*.ts",
    "src/server/**/*.ts",
    "../../packages/schemas/src/**/*.ts",
    "../../packages/shared/src/**/*.ts",
    "../../recipebridge/**/*.rs",
    "../../Cargo.lock",
    "../../pnpm-lock.yaml",
    "tests/e2e/fixtures/synthetic-wardrobe-*.png",
  ])
    .filter((file) => !/\.(?:test|spec)\.ts$/u.test(file))
    .sort())
    hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

/** Only labelled, abandoned checkout databases are eligible for collection. */
export async function pruneCheckoutDatabases(admin: Client): Promise<void> {
  const { rows } = await admin.query<{ name: string; checkout: string }>(
    `SELECT datname AS name, shobj_description(oid, 'pg_database') AS checkout FROM pg_database WHERE datname LIKE 'cubby\\_dev\\_%'`,
  );
  for (const { name, checkout } of rows) {
    if (checkout?.startsWith("/") && !existsSync(checkout))
      await admin.query(
        `DROP DATABASE ${databaseIdentifier(name)} WITH (FORCE)`,
      );
  }
}

export async function prepareDevDatabase(
  name: string,
  checkout: string,
  databaseUrl: string,
): Promise<void> {
  const adminUrl = assertDevDatabaseUrl(databaseUrl);
  if (adminUrl.pathname !== `/${name}` || !checkout.startsWith("/"))
    throw new Error("Dev template target does not match its checkout profile");
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  try {
    await pruneCheckoutDatabases(admin);
    const present = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (!present.rowCount) {
      const hash = corpusTemplateHash();
      const client = templateClient();
      await client.initializeTemplate(hash, async (config) => {
        await cloneSchemaTemplate(config.database);
        const pool = createPostgresPool({
          connectionString: templateConnectionUrl(config),
        });
        // The corpus uploads its three PNGs through the normal storage seam.
        // Clones restore those bundled bytes into their own R2 binding.
        const storage = createServer(async (request, response) => {
          for await (const _chunk of request) {
            /* Drain the upload. */
          }
          response.end();
        });
        storage.listen(0, "127.0.0.1");
        await once(storage, "listening");
        try {
          const address = storage.address();
          if (!address || typeof address === "string")
            throw new Error("Fixture storage did not listen");
          const userStart = performance.now();
          const userId = randomUUID();
          await pool.query(
            'INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)',
            [userId, DEV_USER_NAME, DEV_USER_EMAIL],
          );
          await pool.query(
            "INSERT INTO account (id,account_id,provider_id,user_id,password,updated_at) VALUES ($1,$2,'credential',$2,$3,now())",
            [randomUUID(), userId, await hashPassword(DEV_USER_PASSWORD)],
          );
          console.log(
            `[dev-template] user: ${Math.round(performance.now() - userStart)} ms`,
          );
          const importStart = performance.now();
          const { seedCorpus } = await import("../scenarios/corpus");
          console.log(
            `[dev-template] import: ${Math.round(performance.now() - importStart)} ms`,
          );
          const corpusStart = performance.now();
          await pool.query(
            "CREATE TABLE cubby_dev_background_task (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body jsonb NOT NULL)",
          );
          setCfEnv(
            fromPartial<Env>({
              BACKGROUND_QUEUE: {
                sendBatch: async (messages: Iterable<{ body: unknown }>) => {
                  for (const { body } of messages)
                    await pool.query(
                      "INSERT INTO cubby_dev_background_task (body) VALUES ($1)",
                      [JSON.stringify(body)],
                    );
                },
              },
            }),
          );
          await seedCorpus(pool, userId, {
            storageOrigin: `http://127.0.0.1:${address.port}`,
            bucket: "cubby-local",
            keyPrefix: "cubby-local",
          });
          console.log(
            `[dev-template] corpus (including three local image uploads): ${Math.round(performance.now() - corpusStart)} ms`,
          );
          await seedUpcLookupFixture(pool);
          await pool.query(
            `CREATE TABLE cubby_dev_fixture (pack text PRIMARY KEY, version integer NOT NULL, state text NOT NULL)`,
          );
          await pool.query(
            "INSERT INTO cubby_dev_fixture VALUES ('core',$1,'complete')",
            [LOCAL_FIXTURE_VERSION],
          );
        } finally {
          setCfEnv(undefined);
          await pool.end();
          await new Promise<void>((resolve, reject) =>
            storage.close((error) => (error ? reject(error) : resolve())),
          );
        }
      });
      const lease = await client.api.getTestDatabase(hash);
      const cloneStart = performance.now();
      try {
        await admin.query(
          `CREATE DATABASE ${databaseIdentifier(name)} TEMPLATE ${databaseIdentifier(lease.database.config.database)}`,
        );
        console.log(
          `[dev-template] clone: ${Math.round(performance.now() - cloneStart)} ms`,
        );
      } finally {
        await client.api.reuseTestDatabase(hash, lease.id);
      }
    }
    // Database comments are SQL literals; PostgreSQL COMMENT does not bind parameters.
    await admin.query(
      `COMMENT ON DATABASE ${databaseIdentifier(name)} IS '${checkout.replaceAll("'", "''")}'`,
    );
  } finally {
    await admin.end();
  }
}

if (import.meta.main) {
  const { resolveDevProfile, devProcessEnvironment } =
    await import("../../../../scripts/lib/dev-profile.ts");
  const root = new URL("../../../..", import.meta.url).pathname;
  const profile = resolveDevProfile(root, process.env);
  Object.assign(process.env, devProcessEnvironment(profile));
  await prepareDevDatabase(profile.name, root, profile.databaseUrl);
}
