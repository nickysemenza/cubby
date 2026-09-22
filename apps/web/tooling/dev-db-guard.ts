// Keep these in sync with scripts/dev-db.ts's DEV_DB_HOST/DEV_DB_NAME (a
// different pnpm workspace, so it can't import this module directly).
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
const DEV_DB_NAME = "cubby_dev";

/**
 * Refuse to run a destructive dev-database operation (schema push, corpus
 * seed) against anything but the local `cubby-dev-pg` container. Both
 * `dev-db-push.ts` and `dev-db-seed.ts` call this before touching the
 * database — a mistyped or inherited `DATABASE_URL` must never point either
 * of them at the shared household database.
 */
export function assertDevDatabaseUrl(databaseUrl: string | undefined): URL {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Run this through `pnpm db:dev:push` / " +
        "`pnpm db:dev:seed` (which set it), not directly.",
    );
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${databaseUrl}`);
  }
  const database = url.pathname.replace(/^\//, "");
  if (!ALLOWED_HOSTS.has(url.hostname) || database !== DEV_DB_NAME) {
    throw new Error(
      `Refusing to run against DATABASE_URL host "${url.hostname}" database ` +
        `"${database}". This command only ever runs against the local dev ` +
        `database (host: localhost/127.0.0.1, database: "${DEV_DB_NAME}"), ` +
        `never the shared household database. Run \`pnpm db:dev:up\` first ` +
        `and use \`pnpm db:dev:push\` / \`pnpm db:dev:seed\`.`,
    );
  }
  return url;
}
