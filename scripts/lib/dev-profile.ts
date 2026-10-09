import { createHash } from "node:crypto";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface DevProfile {
  schemaVersion: 1;
  id: string;
  repoRoot: string;
  webRoot: string;
  name: string;
  databaseUrl: string;
  origin: string;
  stateDir: string;
  profile: "offline" | "integrations";
  port: number;
  inspectorPort: number;
  vars: Record<string, string>;
  integration?: { vectorizeIndex: string };
}

function assertDatabaseOverrides(
  inherited: Partial<NodeJS.ProcessEnv>,
  databaseUrl: string,
): void {
  for (const key of [
    "DATABASE_URL",
    "E2E_DATABASE_URL",
    "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
    "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
  ]) {
    const value = inherited[key];
    if (value && value.replace("@127.0.0.1:", "@localhost:") !== databaseUrl)
      throw new Error(
        `Refusing inherited ${key}: local development targets this checkout's database; unset the override`,
      );
  }
}

function assertOrigins(
  inherited: Partial<NodeJS.ProcessEnv>,
  origin: string,
): void {
  for (const key of [
    "R2_ENDPOINT",
    "R2_PUBLIC_URL",
    "APP_ORIGIN",
    "BETTER_AUTH_URL",
  ]) {
    const value = inherited[key];
    if (value && new URL(value).origin !== origin)
      throw new Error(
        `Refusing inherited ${key}: local development requires its own origin; unset the override`,
      );
  }
}

function resolveIntegrations(
  inherited: Partial<NodeJS.ProcessEnv>,
  profile: DevProfile["profile"],
  id: string,
): DevProfile["integration"] {
  let integration: DevProfile["integration"];
  if (profile === "integrations") {
    // AI calls share the `cubby` gateway (labelled `development`); only the
    // vector index, which local writes would corrupt, is checkout-isolated.
    const vectorizeIndex = inherited.CUBBY_DEV_VECTORIZE_INDEX;
    if (!vectorizeIndex?.startsWith(`cubby-dev-${id}`))
      throw new Error(
        `integrations requires CUBBY_DEV_VECTORIZE_INDEX=cubby-dev-${id}[...]`,
      );
    integration = { vectorizeIndex };
  }
  return integration;
}

function migrationIdentity(repoRoot: string) {
  const migrationsRoot = path.join(repoRoot, "apps/web/drizzle");
  const journalPath = path.join(migrationsRoot, "meta/_journal.json");
  const migrations = existsSync(journalPath)
    ? z
        .object({ entries: z.array(z.object({ tag: z.string() })) })
        .parse(JSON.parse(readFileSync(journalPath, "utf8"))).entries
    : [];
  const lastMigration = migrations.at(-1);
  const migrationHash = lastMigration
    ? createHash("sha256")
        .update(
          readFileSync(
            path.join(migrationsRoot, `${lastMigration.tag}.sql`),
            "utf8",
          ),
        )
        .digest("hex")
    : "";
  return { migrationCount: migrations.length, migrationHash };
}

interface LocalSettings {
  id: string;
  origin: string;
  name: string;
  databaseUrl: string;
  profile: DevProfile["profile"];
  inherited: Partial<NodeJS.ProcessEnv>;
  migrationCount: number;
  migrationHash: string;
}
function localVars({
  id,
  origin,
  name,
  databaseUrl,
  profile,
  inherited,
  migrationCount,
  migrationHash,
}: LocalSettings) {
  const vars = {
    NODE_ENV: "development",
    SENTRY_ENVIRONMENT:
      inherited.CUBBY_DEV_TELEMETRY === "true" ? "development" : "test",
    APP_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: createHash("sha256")
      .update(`cubby-local-${id}`)
      .digest("hex"),
    ALLOW_SIGNUP: "true",
    INSECURE_AUTH_COOKIES: "true",
    E2E_AUTH_TEST_MODE: "false",
    DATABASE_URL: databaseUrl,
    R2_ACCESS_KEY_ID: "cubby-local",
    R2_SECRET_ACCESS_KEY: "cubby-local",
    R2_ENDPOINT: `${origin}/__local-storage/s3`,
    R2_BUCKET_NAME: "cubby-local",
    R2_PUBLIC_URL: origin,
    R2_KEY_PREFIX: "cubby-local",
    USDA_API_URL: origin,
    USDA_ACTIVE_RELEASE: "2026-04",
    UPC_UPSTREAM_DISABLED: "true",
    CUBBY_DEV_ID: id,
    CUBBY_DEV_DB_NAME: name,
    CUBBY_DEV_MIGRATION_COUNT: String(migrationCount),
    CUBBY_DEV_MIGRATION_HASH: migrationHash,
    CUBBY_DEV_PROFILE: profile,
    AI_GATEWAY_API_KEY:
      profile === "integrations"
        ? (inherited.CUBBY_DEV_AI_GATEWAY_API_KEY ?? "")
        : "",
    NOTION_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  } satisfies Record<string, string>;
  return vars;
}

export function resolveDevProfile(
  root: string,
  inherited: Partial<NodeJS.ProcessEnv> = process.env,
): DevProfile {
  const repoRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);
  const instance = inherited.CUBBY_DEV_INSTANCE;
  if (instance && !/^[a-z0-9_]{1,24}$/u.test(instance))
    throw new Error(
      "CUBBY_DEV_INSTANCE must contain 1–24 lowercase letters, digits, or underscores",
    );
  const id = createHash("sha256")
    .update(instance ? `${repoRoot}\0${instance}` : repoRoot)
    .digest("hex")
    .slice(0, 10);
  const name = inherited.CUBBY_DEV_DB_NAME ?? `cubby_dev_${id}`;
  if (!/^cubby_dev(?:_[a-z0-9_]+)?$/u.test(name))
    throw new Error(
      "CUBBY_DEV_DB_NAME must be cubby_dev or cubby_dev_<a-z0-9_>",
    );
  const databaseUrl = `postgresql://postgres:password@localhost:55432/${name}`;
  assertDatabaseOverrides(inherited, databaseUrl);
  const port = Number(inherited.PORT ?? 3000);
  const inspectorPort = Number(inherited.CUBBY_DEV_INSPECTOR_PORT ?? 9229);
  for (const number of [port, inspectorPort])
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new Error("Development ports must be integers from 1 to 65535");
  const origin = `http://localhost:${port}`;
  const profile = inherited.CUBBY_DEV_PROFILE ?? "offline";
  if (profile !== "offline" && profile !== "integrations")
    throw new Error("CUBBY_DEV_PROFILE must be offline or integrations");
  assertOrigins(inherited, origin);
  const integration = resolveIntegrations(inherited, profile, id);
  const { migrationCount, migrationHash } = migrationIdentity(repoRoot);
  const vars = localVars({
    id,
    origin,
    name,
    databaseUrl,
    profile,
    inherited,
    migrationCount,
    migrationHash,
  });
  return {
    schemaVersion: 1,
    id,
    repoRoot,
    webRoot: path.join(repoRoot, "apps/web"),
    name,
    databaseUrl,
    origin,
    stateDir: instance
      ? path.join(repoRoot, ".cubby-dev", instance)
      : path.join(repoRoot, ".cubby-dev"),
    profile,
    port,
    inspectorPort,
    vars,
    integration,
  };
}

/** Only explicit integration settings may introduce provider credentials. */
export function devProcessEnvironment(profile: DevProfile): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (
      /^(?:R2_|BETTER_AUTH_|GOOGLE_|NOTION_|AI_GATEWAY_|OPENAI_|ANTHROPIC_|SENTRY_|PRODUCTION_|E2E_)/u.test(
        key,
      )
    )
      delete inherited[key];
  }
  for (const key of ["CLOUDFLARE_ENV", "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH"])
    delete inherited[key];
  if (profile.profile === "offline") {
    delete inherited.CLOUDFLARE_API_TOKEN;
    delete inherited.CLOUDFLARE_API_KEY;
  }
  return {
    ...inherited,
    ...profile.vars,
    PORT: String(profile.port),
    CUBBY_DEV_INSPECTOR_PORT: String(profile.inspectorPort),
    DEPLOY_TARGET: "cloudflare",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: profile.databaseUrl,
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED:
      profile.databaseUrl,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
      profile.databaseUrl,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED:
      profile.databaseUrl,
  };
}
