import type { Amount } from "@cubby/schemas/codec";
import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";

export interface SessionLocation {
  id: LocationId;
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

export function confirmationKey(
  type: "inventory" | "location",
  id: string,
): string {
  return `${type}:${id}`;
}

export function isAuditableLocation(type: LocationType): boolean {
  return type.length > 0;
}

export function isGlobalUnknownLocation(location: InfLocation): boolean {
  return location.name === "Unknown" && !location.parent;
}

export function hasSessionContent(location: InfLocation): boolean {
  return (
    (location.children?.length ?? 0) > 0 ||
    (location.directItemCount ?? 0) > 0 ||
    (location.totalItemCount ?? 0) > 0
  );
}

export function getSessionRootCandidates(
  locations: InfLocation[],
): InfLocation[] {
  return locations
    .filter((location) => {
      if (isGlobalUnknownLocation(location)) return false;
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
    if (isAuditableLocation(node.type)) {
      out.push({
        id: node.id,
        name: node.name,
        type: node.type,
        shortcode: node.shortcode,
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

export function formatSessionPath(path: string[]): string {
  return path.join(" / ");
}
