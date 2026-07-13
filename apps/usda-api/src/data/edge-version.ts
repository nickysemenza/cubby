import type { D1Database } from "@cloudflare/workers-types";
import {
  assertVersion,
  indexTableName,
  searchTableName,
} from "./artifact-layout.js";

export interface VersionTables {
  version: string;
  foodIndex: string;
  foodSearch: string;
}

let activeVersionCache:
  | { promise: Promise<VersionTables>; loadedAt: number }
  | undefined;

function sanitizeVersion(version: string): VersionTables {
  assertVersion(version);
  return {
    version,
    foodIndex: indexTableName(version),
    foodSearch: searchTableName(version),
  };
}

export async function getActiveVersion(db: D1Database): Promise<VersionTables> {
  const now = Date.now();
  if (activeVersionCache && now - activeVersionCache.loadedAt < 60_000) {
    return activeVersionCache.promise;
  }

  activeVersionCache = {
    loadedAt: now,
    promise: db
      .prepare("SELECT value FROM usda_edge_meta WHERE key = ?")
      .bind("active_version")
      .first<{ value: string }>()
      .then((row) => {
        if (!row?.value) {
          throw new Error("No active USDA edge dataset version configured");
        }
        return sanitizeVersion(row.value);
      })
      .catch((error) => {
        // Drop the entry so a transient failure isn't cached for the full TTL.
        activeVersionCache = undefined;
        throw error;
      }),
  };

  return activeVersionCache.promise;
}
