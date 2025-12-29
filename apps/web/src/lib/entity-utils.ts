import type { ReactNode } from "react";

// Field names that typically contain entity images
const IMAGE_FIELDS = ["image", "imageUrl", "thumbnail"] as const;

// Type guard for checking if object has a property
function hasProperty<K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> {
  return typeof obj === "object" && obj !== null && key in obj;
}

// Type guard for objects with a name property
function isObjectWithName(value: unknown): value is { name: string } {
  return (
    hasProperty(value, "name") &&
    typeof value.name === "string" &&
    value.name.trim() !== ""
  );
}

/**
 * Extracts a string title from entity row data.
 * Generic to preserve TItem type - no casting needed at call site.
 */
export function extractEntityTitle<T>(rowData: T): string {
  // Check for name field (most entities: products, locations, recipes, etc.)
  if (
    hasProperty(rowData, "name") &&
    typeof rowData.name === "string" &&
    rowData.name.trim()
  ) {
    return rowData.name;
  }

  // Check for filename field (images)
  if (
    hasProperty(rowData, "filename") &&
    typeof rowData.filename === "string" &&
    rowData.filename.trim()
  ) {
    return rowData.filename;
  }

  // Special case: Inventory entries have both product and location
  // Format: "Product @ Location"
  if (
    hasProperty(rowData, "product") &&
    isObjectWithName(rowData.product) &&
    hasProperty(rowData, "location") &&
    isObjectWithName(rowData.location)
  ) {
    return `${rowData.product.name} @ ${rowData.location.name}`;
  }

  return "Unknown";
}

/**
 * Extracts image content from entity row data
 */
export function getEntityImage(
  rowData: Record<string, unknown>,
): ReactNode | undefined {
  for (const field of IMAGE_FIELDS) {
    const value = rowData[field];
    if (value !== null && value !== undefined) {
      return value as ReactNode;
    }
  }
  return undefined;
}
