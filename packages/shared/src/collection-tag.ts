export const COLLECTION_TAG_PREFIX = "collection:";

export const collectionSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const isCollectionTag = (tag: string): boolean =>
  tag.startsWith(COLLECTION_TAG_PREFIX) &&
  collectionSlugPattern.test(tag.slice(COLLECTION_TAG_PREFIX.length));

export const collectionTagFromSlug = (slug: string): string =>
  `${COLLECTION_TAG_PREFIX}${slug}`;

export const collectionSlugFromTag = (tag: string): string | null =>
  isCollectionTag(tag) ? tag.slice(COLLECTION_TAG_PREFIX.length) : null;

export const normalizeCollectionSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

export const formatCollectionLabel = (slug: string): string =>
  slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

export const collectionSlugsFromTags = (tags: readonly string[]): string[] =>
  [...new Set(tags.flatMap((tag) => collectionSlugFromTag(tag) ?? []))].sort();

export const setCollectionTag = (
  tags: readonly string[],
  slug: string,
  assigned: boolean,
): string[] => {
  const target = collectionTagFromSlug(slug);
  const withoutTarget = tags.filter((tag) => tag !== target);
  return assigned ? [...withoutTarget, target] : withoutTarget;
};
