/**
 * Pure queue logic for the location photo pass. Kept free of React and tRPC so
 * the walk order, the "needs a photo" rule, and the advance cursor are testable
 * on plain fixtures.
 */

import type { ImageOut } from "@cubby/schemas/image";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { InfLocation, LocationType } from "@cubby/schemas/location";

export interface PhotoStop {
  id: InfLocation["id"];
  name: string;
  type: LocationType;
  /** Names from the scoped root down to and including this location. */
  path: string[];
  depth: number;
  images: ImageOut[];
  aiDescription: string | null;
  location: InfLocation;
}

export interface PhotoStopFilters {
  /** Include locations that already have a photo (a deliberate re-shoot). */
  includePhotographed?: boolean;
  /** Restrict to these location types; empty/omitted means every type. */
  types?: readonly LocationType[];
}

/**
 * Whether a location still owes us a photo.
 *
 * Keyed on *displayable* images rather than `images.length` so this agrees with
 * the locations list's `imagePresenceFilter`, whose subquery joins through
 * `displayableImageWhere`. A location holding only a PDF attachment or a failed
 * render reads as "(none)" there and must read as needing a photo here, or the
 * backlog count and the queue length disagree.
 */
export function needsPhoto(location: {
  images?: ImageOut[] | undefined;
}): boolean {
  return !(location.images ?? []).some(isDisplayableImageFile);
}

/**
 * Depth-first walk of a location forest into an ordered queue of stops.
 *
 * Every location is a candidate stop regardless of type or contents — a room's
 * photo is what the AI vision description actually reads, so excluding
 * non-container types would drop the most informative shots. Filtering is the
 * caller's, via {@link PhotoStopFilters}.
 *
 * Note the recursion is unconditional: a location that fails the filter still
 * has its descendants visited, so narrowing to (say) totes does not hide totes
 * nested under a filtered-out shelf.
 */
export function flattenPhotoStops(
  roots: InfLocation[],
  filters: PhotoStopFilters = {},
): PhotoStop[] {
  const { includePhotographed = false, types } = filters;
  const typeFilter = types && types.length > 0 ? new Set(types) : null;
  const out: PhotoStop[] = [];

  const visit = (node: InfLocation, path: string[], depth: number) => {
    const nextPath = [...path, node.name];
    const typeMatches = !typeFilter || typeFilter.has(node.type);
    const photoMatches = includePhotographed || needsPhoto(node);

    if (typeMatches && photoMatches) {
      out.push({
        id: node.id,
        name: node.name,
        type: node.type,
        path: nextPath,
        depth,
        images: node.images ?? [],
        aiDescription: node.aiDescription ?? null,
        location: node,
      });
    }

    for (const child of node.children ?? []) {
      visit(child, nextPath, depth + 1);
    }
  };

  for (const root of roots) visit(root, [], 0);

  return out;
}

/**
 * The next stop that still needs attention: scan forward from `currentIndex`,
 * then wrap to the first outstanding stop before it. Returns `currentIndex`
 * when everything is settled, so the caller's "pass complete" check stays a
 * separate, explicit test rather than a sentinel.
 *
 * Callers must pass a `settled` set that already includes the stop they just
 * finished — the React state holding it has not flushed yet at call time.
 */
export function advanceToOutstanding(
  stops: readonly PhotoStop[],
  currentIndex: number,
  settled: ReadonlySet<string>,
): number {
  const after = stops.findIndex(
    (stop, index) => index > currentIndex && !settled.has(stop.id),
  );
  if (after >= 0) return after;
  const wrapped = stops.findIndex((stop) => !settled.has(stop.id));
  return wrapped >= 0 ? wrapped : currentIndex;
}

/** True once every stop has been photographed or skipped. */
export function isPassComplete(
  stops: readonly PhotoStop[],
  settled: ReadonlySet<string>,
): boolean {
  return stops.length > 0 && stops.every((stop) => settled.has(stop.id));
}
