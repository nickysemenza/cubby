/**
 * Location path utilities for formatting and parsing location hierarchies.
 *
 * These are pure string transformation functions with no database dependencies.
 * Path format: "Name[type] > ChildName[type]" (e.g., "Kitchen[room] > Pantry[shelf]")
 */

import { locationType, type LocationType } from "~/schemas/location";

// Recursive type for location with parent chain
export type LocationWithParent = {
  name: string;
  type: string;
  parent?: LocationWithParent | null;
};

// Type context for batch CSV imports with type inference
export interface LocationTypeContext {
  // Map of "full_path" (lowercase) -> type from CSV bracket notation
  pathTypes: Map<string, LocationType>;
  // Map of "name" (lowercase) -> type from existing database locations
  existingTypes: Map<string, LocationType>;
  // Detected conflicts: same path with different types in CSV
  conflicts: Array<{ path: string; types: LocationType[] }>;
}

/**
 * Get the default location type for a given depth in the hierarchy.
 * Root (depth 0) = "room", all children = "shelf"
 */
export const getDefaultLocationType = (depth: number): LocationType =>
  depth === 0 ? "room" : "shelf";

/**
 * Build a location path string from a location with its parent chain.
 * Only includes [type] brackets when the type differs from the default.
 * Default types: root = "room", children = "shelf"
 *
 * @example
 * buildLocationPath({ name: "Pantry", type: "shelf", parent: { name: "Kitchen", type: "room", parent: null } })
 * // Returns: "Kitchen > Pantry" (types match defaults, no brackets needed)
 *
 * buildLocationPath({ name: "Pantry", type: "cabinet", parent: { name: "Kitchen", type: "room", parent: null } })
 * // Returns: "Kitchen > Pantry[cabinet]" (Pantry is cabinet, not default shelf)
 */
export const buildLocationPath = (
  locationData: LocationWithParent,
  separator = " > ",
): string => {
  // First collect all parts in order (root to leaf)
  const parts: Array<{ name: string; type: string }> = [];
  let current: LocationWithParent | null | undefined = locationData;
  while (current) {
    parts.unshift({ name: current.name, type: current.type });
    current = current.parent;
  }

  // Build path with minimal brackets
  return parts
    .map((part, index) => {
      const defaultType = getDefaultLocationType(index);
      if (part.type === defaultType) {
        return part.name;
      }
      return `${part.name}[${part.type}]`;
    })
    .join(separator);
};

/**
 * Normalize a location path by stripping [type] brackets.
 * Useful for comparing paths regardless of type annotations.
 *
 * @example
 * normalizeLocationPath("Kitchen[room] > Pantry[shelf]")
 * // Returns: "kitchen > pantry"
 */
export const normalizeLocationPath = (path: string): string => {
  return path
    .split(" > ")
    .map((part) => {
      // Strip bracket notation: "name[type]" -> "name"
      const match = part.trim().match(/^(.+?)\[([^\]]+)\]$/);
      return match ? match[1].trim() : part.trim();
    })
    .join(" > ")
    .toLowerCase();
};

/**
 * Parse a location path with optional embedded types.
 * Supports both plain format ("garage > shelf") and typed format ("garage[room] > shelf[shelf]")
 *
 * @param path - Path string like "garage[room] > shelf[shelf]" or "garage > shelf"
 * @param separator - Path separator, defaults to " > "
 * @returns Array of {name, type} objects
 */
export const parseLocationPathWithTypes = (
  path: string,
  separator = " > ",
): Array<{ name: string; type: LocationType }> => {
  const parts = path.split(separator).map((p) => p.trim());

  return parts.map((part, index) => {
    // Match "name[type]" format
    const match = part.match(/^(.+?)\[([^\]]+)\]$/);
    if (match) {
      const name = match[1].trim();
      const typeStr = match[2].trim();
      // Validate the type
      const parsedType = locationType.safeParse(typeStr);
      if (parsedType.success) {
        return { name, type: parsedType.data };
      }
      // Invalid type - fall back to default
      console.warn(`Invalid location type "${typeStr}" in path, using default`);
    }
    // No bracket notation or invalid - use defaults: root = room, children = shelf
    return { name: part, type: index === 0 ? "room" : "shelf" };
  });
};

/**
 * Parse a location path using type context for inference.
 * Uses bracket notation first, then CSV context, then DB context, then defaults.
 *
 * @param path - Path string like "garage > shelf"
 * @param context - Type context from buildLocationTypeContext
 * @param separator - Path separator, defaults to " > "
 * @returns Array of {name, type} objects
 */
export const parseLocationPathWithContext = (
  path: string,
  context: LocationTypeContext,
  separator = " > ",
): Array<{ name: string; type: LocationType }> => {
  const parts = path.split(separator).map((p) => p.trim());
  const result: Array<{ name: string; type: LocationType }> = [];
  const pathSegments: string[] = [];

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];

    // Check for explicit bracket notation first
    const match = part.match(/^(.+?)\[([^\]]+)\]$/);
    if (match) {
      const name = match[1].trim();
      const typeStr = match[2].trim();
      const parsedType = locationType.safeParse(typeStr);
      if (parsedType.success) {
        result.push({ name, type: parsedType.data });
        pathSegments.push(name.toLowerCase());
        continue;
      }
      // Invalid type - fall through to inference
    }

    // Extract name (strip brackets if present but type was invalid)
    const name = match ? match[1].trim() : part;
    pathSegments.push(name.toLowerCase());
    const fullPath = pathSegments.join(separator);

    // Priority 1: Type from CSV context (another row with explicit type)
    const csvType = context.pathTypes.get(fullPath);
    if (csvType) {
      result.push({ name, type: csvType });
      continue;
    }

    // Priority 2: Type from existing database location
    const dbType = context.existingTypes.get(name.toLowerCase());
    if (dbType) {
      result.push({ name, type: dbType });
      continue;
    }

    // Priority 3: Default (root=room, children=shelf)
    result.push({ name, type: index === 0 ? "room" : "shelf" });
  }

  return result;
};
