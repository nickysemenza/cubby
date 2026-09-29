type PushSchemaDatabase = Parameters<
  (typeof import("drizzle-kit/api"))["pushSchema"]
>[1];

interface PushSchemaRuntime {
  readonly _: unknown;
  readonly execute: unknown;
}

/**
 * Restore the database type expected by drizzle-kit's private Drizzle copy.
 * Only `db:check`'s reference build (schema.ts pushed) still needs it.
 */
export function toPushSchemaDatabase(
  value: PushSchemaRuntime,
): PushSchemaDatabase {
  // SAFETY: drizzle-kit and the application resolve distinct drizzle-orm
  // package instances. The runtime handle exposes the metadata and execute
  // members pushSchema consumes; only the duplicate package identity differs.
  return value as PushSchemaDatabase;
}
