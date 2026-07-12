/**
 * Canonical entity-embedding repository barrel.
 *
 * Keep callers on this path while search, refresh/upsert, and cleanup remain
 * independently testable storage responsibilities.
 */
export * from "./entity-embedding-cleanup";
export * from "./entity-embedding-refresh";
export * from "./entity-embedding-search";
