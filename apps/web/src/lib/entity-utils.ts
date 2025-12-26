import type { ReactNode } from "react";

// Field names that typically contain the entity title
const TITLE_FIELDS = ["name", "filename"] as const;

// Field names that typically contain entity images
const IMAGE_FIELDS = ["image", "imageUrl", "thumbnail"] as const;

/**
 * Extracts a string title from entity row data
 */
export function extractEntityTitle(rowData: Record<string, unknown>): string {
  for (const field of TITLE_FIELDS) {
    const value = rowData[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
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
