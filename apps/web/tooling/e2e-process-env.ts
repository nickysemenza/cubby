/**
 * Placeholder service settings that satisfy server import-time validation in a
 * local test process without credential files. Callers override the storage
 * origin they actually serve.
 */
export function localTestEnvironment(
  overrides: Readonly<Record<string, string>> = {},
) {
  return {
    R2_ACCESS_KEY_ID: "e2e",
    R2_SECRET_ACCESS_KEY: "e2e",
    R2_ENDPOINT: "http://localhost:9000",
    R2_BUCKET_NAME: "e2e-bucket",
    R2_PUBLIC_URL: "http://localhost:9000",
    UPC_UPSTREAM_DISABLED: "true",
    ...overrides,
  };
}

/** Node-side browser fixtures validate server imports before a leased Worker exists. */
export function prepareE2EProcessEnvironment() {
  // The runtime supplies the actual isolated database/storage bindings. These
  // placeholders satisfy import-time validation without loading credential files.
  const defaults = localTestEnvironment({
    E2E_TEST_USER_EMAIL: "e2e@example.test",
    E2E_TEST_USER_PASSWORD: "cubby-e2e-local-only",
    DATABASE_URL: "postgresql://postgres:password@localhost:5432/cubby",
    BETTER_AUTH_SECRET: "e2e-test-secret",
  });
  for (const [key, value] of Object.entries(defaults))
    process.env[key] ??= value;
}
