// Single source of truth for the build ↔ runtime artifact contract:
// the build script (scripts/build-edge-artifacts.ts) writes D1 tables and R2
// objects using these names, and the Worker runtime (edge.ts) reads them back.
// Keep this module dependency-free so it bundles into the Worker and runs
// under tsx alike.

const VERSION_RE = /^v[0-9A-Za-z_]+$/;

export function assertVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Use vYYYYMMDD-style names.`);
  }
}

const DATA_TYPE_ALIASES: Record<string, string> = {
  market_acquistion: "market_acquisition",
};

export function normalizeDataType(dataType: string): string {
  return DATA_TYPE_ALIASES[dataType] ?? dataType;
}

export function indexTableName(version: string): string {
  return `food_index_${version}`;
}

export function searchTableName(version: string): string {
  return `food_search_${version}`;
}

export function manifestKey(version: string): string {
  return `usda/${version}/manifest.json`;
}

export function bundlePrefix(version: string): string {
  return `usda/${version}/bundles/`;
}

export function bundleKey(version: string, index: number): string {
  return `${bundlePrefix(version)}food-${String(index).padStart(6, "0")}.ndjson`;
}
