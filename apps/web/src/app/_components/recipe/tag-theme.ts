import { BookIcon as Book } from "@phosphor-icons/react/dist/csr/Book";
import { ForkKnifeIcon as UtensilsCrossed } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { TagIcon as Tag } from "@phosphor-icons/react/dist/csr/Tag";
import { UserIcon as User } from "@phosphor-icons/react/dist/csr/User";
import type { Icon } from "@phosphor-icons/react/lib";

/**
 * Known tag prefixes with their display info
 * Tags can be:
 * - Prefixed: "cuisine:thai", "author:kenji", "cookbook:ottolenghi"
 * - Plain: "quick", "kid-approved", "make-ahead"
 */
type TagPrefix = "cuisine" | "author" | "cookbook" | "none";
interface ParsedTag {
  prefix: TagPrefix;
  value: string;
}

/**
 * Extract prefix and value from a tag string
 * "cuisine:thai" -> { prefix: "cuisine", value: "thai" }
 * "quick" -> { prefix: "none", value: "quick" }
 */
export function parseTag(tag: string): ParsedTag {
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
 * Color palette for tag prefixes, mapped onto Porcelain semantic tokens
 * (styles.css) rather than raw HSL so tags track the design system:
 * cuisine→warning, author→primary, cookbook→finance-domain magenta,
 * plain→graphite-secondary. Returned as
 * `var(--token)` strings for use in inline `color` / `borderColor`.
 */
const tagPrefixColors = {
  cuisine: "var(--warning)",
  author: "var(--primary)",
  cookbook: "var(--plum)",
  none: "var(--slate)",
} satisfies Record<TagPrefix, string>;

/**
 * Get the color for a tag prefix
 */
export const getTagColor = (prefix: TagPrefix): string =>
  tagPrefixColors[prefix];

/**
 * Faint background tint for a tag chip — the prefix color mixed down over the
 * surface via color-mix. (The previous `${color}15` alpha-concat produced
 * invalid CSS for both hsl() and var() values, so the tint never rendered.)
 */
export const getTagTint = (prefix: TagPrefix): string =>
  `color-mix(in oklch, ${tagPrefixColors[prefix]} 12%, transparent)`;

/**
 * Get the icon component for a tag prefix
 */
export const getTagIcon = (prefix: TagPrefix): Icon => {
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
