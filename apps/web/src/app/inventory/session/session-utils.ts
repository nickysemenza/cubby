import type { Amount } from "@cubby/schemas/codec";
import {
  type LocationShortcode,
  locationShortcode,
} from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";

export interface SessionLocation {
  id: LocationShortcode;
  name: string;
  type: LocationType;
  shortcode: string;
  lastBulkInventory: Date | null;
  aiDescription: string | null;
  imageCount: number;
  path: string[];
  depth: number;
  location: InfLocation;
}

interface PickerTreeRow {
  location: InfLocation;
  depth: number;
  hasCandidateChildren: boolean;
}

export function confirmationKey(
  type: "inventory" | "location",
  id: string,
): string {
  return `${type}:${id}`;
}

function isGlobalUnknownLocation(location: InfLocation): boolean {
  return location.name === "Unknown" && !location.parent;
}

function hasSessionItems(location: InfLocation): boolean {
  return (
    (location.directItemCount ?? 0) > 0 || (location.totalItemCount ?? 0) > 0
  );
}

function hasSessionContent(location: InfLocation): boolean {
  return (location.children?.length ?? 0) > 0 || hasSessionItems(location);
}

export function getSessionRootCandidates(
  locations: InfLocation[],
): InfLocation[] {
  return locations
    .filter((location) => {
      // Unknown is a legitimate root: recounting it *is* how you drain it
      // (relocate each row to where it belongs). It only earns a slot while it
      // actually holds items — an empty Unknown is noise, not a sweep.
      if (isGlobalUnknownLocation(location)) return hasSessionItems(location);
      return hasSessionContent(location);
    })
    .sort((a, b) => {
      const aRootish = a.type === "room" || a.type === "area";
      const bRootish = b.type === "room" || b.type === "area";
      if (aRootish !== bRootish) return aRootish ? -1 : 1;

      const countDelta = (b.totalItemCount ?? 0) - (a.totalItemCount ?? 0);
      if (countDelta !== 0) return countDelta;

      return a.name.localeCompare(b.name);
    });
}

function sortedLocations(locations: InfLocation[]): InfLocation[] {
  return [...locations].sort((a, b) => a.name.localeCompare(b.name));
}

function hasCandidateDescendant(
  location: InfLocation,
  candidateIds: Set<string>,
): boolean {
  return (location.children ?? []).some(
    (child) =>
      candidateIds.has(child.id) || hasCandidateDescendant(child, candidateIds),
  );
}

function matchesPickerSearch(
  location: InfLocation,
  path: string[],
  searchTerm: string,
): boolean {
  if (!searchTerm) return true;
  const haystack = [...path, location.type].join(" ").toLocaleLowerCase();
  return haystack.includes(searchTerm.toLocaleLowerCase());
}

export function flattenPickerTree(
  roots: InfLocation[],
  candidateIds: Set<string>,
  {
    expandedIds = new Set<string>(),
    searchTerm = "",
  }: { expandedIds?: Set<string>; searchTerm?: string } = {},
): PickerTreeRow[] {
  const rows: PickerTreeRow[] = [];
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();

  const visit = (
    location: InfLocation,
    depth: number,
    path: string[],
  ): PickerTreeRow[] => {
    const isCandidate = candidateIds.has(location.id);
    const nextPath = [...path, location.name];
    const hasCandidateChildren = hasCandidateDescendant(location, candidateIds);
    const searching = normalizedSearch.length > 0;
    const shouldTraverseChildren =
      searching || !isCandidate || expandedIds.has(location.id);

    const childRows = shouldTraverseChildren
      ? sortedLocations(location.children ?? []).flatMap((child) =>
          visit(child, depth + 1, nextPath),
        )
      : [];

    if (!isCandidate) return childRows;

    const matches = matchesPickerSearch(location, nextPath, normalizedSearch);
    if (searching && !matches && childRows.length === 0) return [];

    return [{ location, depth, hasCandidateChildren }, ...childRows];
  };

  for (const root of sortedLocations(roots)) {
    rows.push(...visit(root, 0, []));
  }

  return rows;
}

export function getDirectChildLocations(location: InfLocation): InfLocation[] {
  return location.children ?? [];
}

export function getUnknownChildLocations(
  unknownLocation: InfLocation | null | undefined,
): InfLocation[] {
  return unknownLocation?.children ?? [];
}

export function flattenAuditableLocations(
  parent: InfLocation,
): SessionLocation[] {
  const out: SessionLocation[] = [];

  const visit = (node: InfLocation, path: string[], depth: number) => {
    const nextPath = [...path, node.name];
    // A recount reconciles an expected inventory snapshot. An empty location
    // has no snapshot to confirm, so it is not a stop and receives no implicit
    // audit stamp. Its stocked descendants still remain independent stops.
    if ((node.directItemCount ?? 0) > 0) {
      out.push({
        id: node.id,
        name: node.name,
        type: node.type,
        shortcode: node.id,
        lastBulkInventory: node.lastBulkInventory,
        aiDescription: node.aiDescription,
        imageCount: node.images?.length ?? 0,
        path: nextPath,
        depth,
        location: node,
      });
    }

    for (const child of node.children ?? []) {
      visit(child, nextPath, depth + 1);
    }
  };

  visit(parent, [], 0);

  return out;
}

export function flattenAllLocations(tree: InfLocation[]): InfLocation[] {
  const out: InfLocation[] = [];
  const visit = (node: InfLocation) => {
    out.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of tree) visit(node);
  return out;
}

export function findLocationInTree(
  tree: InfLocation[] | undefined,
  locationId: string | undefined,
): InfLocation | null {
  if (!tree || !locationId) return null;
  return flattenAllLocations(tree).find((loc) => loc.id === locationId) ?? null;
}

export function findLocationInTreeByShortcode(
  tree: InfLocation[] | undefined,
  shortcode: string | undefined,
): InfLocation | null {
  if (!tree || !shortcode) return null;
  return flattenAllLocations(tree).find((loc) => loc.id === shortcode) ?? null;
}

export function isDescendantLocation(
  parent: InfLocation,
  candidateId: string,
): boolean {
  if (parent.id === candidateId) return true;
  return flattenAllLocations(parent.children ?? []).some(
    (loc) => loc.id === candidateId,
  );
}

export function buildBulkMovePayloadItems<
  TItem extends { id: string; amount: Amount },
>(items: TItem[]) {
  return items.map((item) => ({
    inventoryEntryId: item.id,
    quantity: item.amount,
  }));
}

export function parseLocationIdFromInput(
  raw: string,
): LocationShortcode | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];

  try {
    const url = new URL(trimmed);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) candidates.push(lastSegment);
  } catch {
    // Plain shortcode/UUID input is expected most of the time.
  }

  for (const candidate of candidates) {
    const parsed = locationShortcode.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  return null;
}

export function locationTypeNoun(type: string): string {
  return type.replaceAll("-", " ");
}

function locationPathFromRoot(
  root: InfLocation,
  locationId: string,
): InfLocation[] {
  if (root.id === locationId) return [root];

  for (const child of root.children ?? []) {
    const childPath = locationPathFromRoot(child, locationId);
    if (childPath.length > 0) return [root, ...childPath];
  }

  return [];
}

export function sessionBreadcrumbSegments(
  parent: InfLocation,
  locationId: string,
) {
  return locationPathFromRoot(parent, locationId).map((location) => ({
    id: location.id,
    name: location.name,
    type: location.type,
  }));
}

export function formatChildCount(count: number) {
  return count === 1 ? "1 child" : `${count} children`;
}
