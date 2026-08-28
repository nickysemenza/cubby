type PushSchemaDatabase = Parameters<
  (typeof import("drizzle-kit/api"))["pushSchema"]
>[1];

interface PushSchemaRuntime {
  readonly _: unknown;
  readonly execute: unknown;
}

/**
 * Restore the database type expected by drizzle-kit's private Drizzle copy.
 * Keep this dependency-identity boundary in one place for every schema setup.
 */
export function toPushSchemaDatabase(
  value: PushSchemaRuntime,
): PushSchemaDatabase {
  // SAFETY: drizzle-kit and the application resolve distinct drizzle-orm
  // package instances. The runtime handle exposes the metadata and execute
  // members pushSchema consumes; only the duplicate package identity differs.
  return value as PushSchemaDatabase;
}
