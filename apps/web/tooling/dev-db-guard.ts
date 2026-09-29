// This guard also runs in workerd; keep it free of Node-only profile tooling.
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
// `cubby_dev`, or a branch's own `cubby_dev_<name>` (CUBBY_DEV_DB_NAME) in the
// same container, so a branch with newer migrations never migrates the
// database other worktrees share.
const DEV_DB_NAME = /^cubby_dev(?:_[a-z0-9_]+)?$/u;
const DEV_DB_PORT = "55432";

/**
 * Refuse to run a destructive dev-database operation (migration, corpus
 * seed) against anything but the local `cubby-dev-pg` container. Both
 * `db-migrate.ts --target=dev` and `dev-db-seed.ts` call this before touching the
 * database — a mistyped or inherited `DATABASE_URL` must never point either
 * of them at the shared household database.
 */
export function assertDevDatabaseUrl(databaseUrl: string | undefined): URL {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Use `pnpm db:dev:migrate` or `pnpm dev:seed`.",
    );
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${databaseUrl}`);
  }
  const database = url.pathname.replace(/^\//, "");
  if (
    url.protocol !== "postgresql:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    url.port !== DEV_DB_PORT ||
    url.username !== "postgres" ||
    url.password !== "password" ||
    !DEV_DB_NAME.test(database) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Refusing DATABASE_URL: expected the exact local dev PostgreSQL " +
        `connection (postgres@localhost/127.0.0.1:${DEV_DB_PORT}/cubby_dev[_<name>]).`,
    );
  }
  return url;
}
