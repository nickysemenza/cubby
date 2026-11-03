import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

/**
 * Schema 2 only adds sleeping tasks; committed entries and usage documents keep
 * their schema-1 layouts. Observation must not open/migrate an execution store.
 */
export function assertReadablePiSqliteSchema(
  retainedVersion: number | undefined,
) {
  const knownLayout = (version: number | undefined) =>
    version === 1 || version === 2;
  if (
    !knownLayout(CURRENT_SQLITE_SCHEMA_VERSION) ||
    !knownLayout(retainedVersion)
  )
    throw new Error(
      `Retained pi SQLite schema ${retainedVersion}, installed schema ${CURRENT_SQLITE_SCHEMA_VERSION}; read adapters support 1 and 2`,
    );
}
