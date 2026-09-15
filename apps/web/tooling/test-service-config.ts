// Resolve only in PostgreSQL paths: PGlite also imports the shared teardown.
export function testServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.INTEGRESQL_DATABASE_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("INTEGRESQL_DATABASE_PORT must be a port number");
  }
  return {
    url: (env.INTEGRESQL_URL ?? "http://localhost:5000").replace(/\/$/u, ""),
    host: env.INTEGRESQL_DATABASE_HOST ?? "localhost",
    port,
  };
}
