import {
  Book,
  type LucideIcon,
  Tag,
  User,
  UtensilsCrossed,
} from "lucide-react";

/**
 * Known tag prefixes with their display info
 * Tags can be:
 * - Prefixed: "cuisine:thai", "author:kenji", "cookbook:ottolenghi"
 * - Plain: "quick", "kid-approved", "make-ahead"
 */
type TagPrefix = "cuisine" | "author" | "cookbook" | "none";

/**
 * Extract prefix and value from a tag string
 * "cuisine:thai" -> { prefix: "cuisine", value: "thai" }
 * "quick" -> { prefix: "none", value: "quick" }
 */
export function parseTag(tag: string): { prefix: TagPrefix; value: string } {
  const colonIndex = tag.indexOf(":");
  if (colonIndex === -1) {
    return { prefix: "none", value: tag };
  }

  const prefix = tag.slice(0, colonIndex).toLowerCase();
  const value = tag.slice(colonIndex + 1);

  // Check if it's a known prefix
  if (isKnownPrefix(prefix)) {
    return { prefix, value };
  }

  // Unknown prefix, treat as plain tag
  return { prefix: "none", value: tag };
}

function isKnownPrefix(prefix: string): prefix is TagPrefix {
  return ["cuisine", "author", "cookbook"].includes(prefix);
}

/**
 * Color palette for tag prefixes
 */
const tagPrefixColors: Record<TagPrefix, string> = {
  cuisine: "hsl(25, 75%, 50%)", // Orange
  author: "hsl(220, 65%, 50%)", // Blue
  cookbook: "hsl(280, 55%, 50%)", // Purple
  none: "hsl(0, 0%, 55%)", // Neutral gray
};

/**
 * Get the color for a tag prefix
 */
export const getTagColor = (prefix: TagPrefix): string =>
  tagPrefixColors[prefix];

/**
 * Get the icon component for a tag prefix
 */
export const getTagIcon = (prefix: TagPrefix): LucideIcon => {
  switch (prefix) {
    case "cuisine":
      return UtensilsCrossed;
    case "author":
      return User;
    case "cookbook":
      return Book;
    case "none":
      return Tag;
  }
};

/**
 * Get display label for a tag (removes prefix if present)
 */
export const getTagDisplayLabel = (tag: string): string => {
  const { value } = parseTag(tag);
  return value;
};

/**
 * Known prefixes for autocomplete suggestions
 */
export const TAG_PREFIXES: TagPrefix[] = ["cuisine", "author", "cookbook"];
