import type { Amount } from "@cubby/schemas/codec";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";

export interface SessionLocation {
  id: LocationShortcode;
  name: string;
  type: LocationType | null;
  /** The SKU this location IS; supplies the glyph when `type` is null. */
  product: InfLocation["product"];
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
  return location.name === "Unknown";
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
      // Unknown is a legitimate session scope: recounting it *is* how you drain it
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
        product: node.product,
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

/**
 * The node that currently holds `childId`, read off the tree.
 *
 * Adopting a bin has to record where it came from so undo can put it back;
 * the in-memory session nodes do not all carry a `parentId` to read instead.
 */
export function findParentLocation(
  tree: InfLocation[] | undefined,
  childId: string,
): InfLocation | null {
  if (!tree) return null;
  return (
    flattenAllLocations(tree).find((node) =>
      (node.children ?? []).some((child) => child.id === childId),
    ) ?? null
  );
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

/**
 * What a scanned location QR means relative to where you are standing.
 *
 * Deliberately about the TREE, not about pass membership. A bin that got
 * carried into another room is often still inside the recount's root, so
 * classifying by "is it a stop in this pass" would call it a jump and quietly
 * lose the case this exists for — adopting a bin that wandered.
 */
export type ScannedLocationRelation =
  /** The bin you are already standing at. */
  | "current"
  /** Already somewhere inside the current bin — nothing to adopt. */
  | "inside"
  /** Contains the current bin, so adopting it would make a cycle. */
  | "ancestor"
  /** Anywhere else: the adoptable case. */
  | "elsewhere";

export function classifyScannedLocation(
  root: InfLocation,
  current: InfLocation,
  targetId: string,
): ScannedLocationRelation {
  if (targetId === current.id) return "current";
  if (isDescendantLocation(current, targetId)) return "inside";

  // An ancestor is any node on the path from the tree root down to `current`.
  // Reading it off the tree beats walking `parentId` links, which the session's
  // in-memory nodes do not all carry.
  const ancestors = flattenAllLocations([root]).filter(
    (node) => node.id !== current.id && isDescendantLocation(node, current.id),
  );
  if (ancestors.some((node) => node.id === targetId)) return "ancestor";

  return "elsewhere";
}

export function buildBulkMovePayloadItems<
  TItem extends { id: string; amount: Amount },
>(items: TItem[]) {
  return items.map((item) => ({
    inventoryEntryId: item.id,
    quantity: item.amount,
  }));
}

export function locationTypeNoun(type: string | null): string {
  // Null means the location IS a product, so it has no form-factor word of its
  // own. Callers that have the product should show its name instead.
  return type === null ? "container" : type.replaceAll("-", " ");
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
