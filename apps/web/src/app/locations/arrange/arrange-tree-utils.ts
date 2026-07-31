import type {
  InventoryShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";

/**
 * Pure, view-agnostic helpers shared by the Board (Miller columns) and Tree
 * renderers of the /locations/arrange surface. All operate on the `InfLocation[]`
 * roots returned by `location.makeTree`. Kept free of React/tRPC so they can be
 * unit-tested and reused for optimistic cache surgery.
 *
 * Note on counts: `applyLocationMove`/`applyItemMove` relocate nodes/items but do
 * NOT recompute `childCount`/`totalItemCount`/valuation — those are corrected by
 * the `onSettled` invalidation refetch. Optimism only needs the node in its new
 * place instantly; stale rollup numbers for one paint are acceptable.
 */

const UNKNOWN_LOCATION_NAME = "Unknown";

/** Item count to show on a node: prefer the subtree rollup, fall back down. */
export function locationItemCount(node: InfLocation): number {
  return (
    node.totalItemCount ??
    node.directItemCount ??
    node.inventoryItems?.length ??
    0
  );
}

/** The global "Unknown" staging location: a top-level node named "Unknown". */
function isUnknownRoot(location: InfLocation): boolean {
  return location.name === UNKNOWN_LOCATION_NAME && !location.parent;
}

/** The global "Unknown" root among the tree roots, or null if it doesn't exist yet. */
export function findUnknownRoot(roots: InfLocation[]): InfLocation | null {
  return roots.find(isUnknownRoot) ?? null;
}

/** Depth-first search for a location node by id across the whole forest. */
export function findNode(
  roots: InfLocation[],
  id: LocationShortcode,
): InfLocation | null {
  for (const node of roots) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return null;
}

/**
 * Id of the parent of `id`, or null if `id` is a top-level root (or absent).
 * Used to detect no-op reparents (dropping onto the current parent).
 */
export function parentIdOf(
  roots: InfLocation[],
  id: LocationShortcode,
): LocationShortcode | null {
  for (const node of roots) {
    for (const child of node.children ?? []) {
      if (child.id === id) return node.id;
    }
    const nested = parentIdOf(node.children ?? [], id);
    if (nested) return nested;
  }
  return null;
}

/**
 * Full path of location ids from a top-level root down to (and including) `id`,
 * or `[]` if `id` isn't in the forest. Unlike appending to a zoom path, this
 * works for a node at ANY depth — so drilling into a grandchild resolves the
 * complete ancestor chain instead of skipping intermediate levels.
 */
export function pathToNode(
  roots: InfLocation[],
  id: LocationShortcode,
): LocationShortcode[] {
  const walk = (
    nodes: InfLocation[],
    trail: LocationShortcode[],
  ): LocationShortcode[] | null => {
    for (const node of nodes) {
      const next = [...trail, node.id];
      if (node.id === id) return next;
      const found = walk(node.children ?? [], next);
      if (found) return found;
    }
    return null;
  };
  return walk(roots, []) ?? [];
}

/**
 * True when `candidateId` is `rootId` itself or lives anywhere in its subtree.
 * This is the cycle guard for reparenting: you may not drop a location onto
 * itself or any of its own descendants.
 */
export function isSelfOrDescendant(
  roots: InfLocation[],
  rootId: LocationShortcode,
  candidateId: LocationShortcode,
): boolean {
  const root = findNode(roots, rootId);
  if (!root) return false;
  const walk = (node: InfLocation): boolean => {
    if (node.id === candidateId) return true;
    return (node.children ?? []).some(walk);
  };
  return walk(root);
}

/**
 * May the dragged location be reparented under `targetId`?
 * Invalid when: dragging Unknown itself, target is the node or a descendant
 * (cycle), or target is already the current parent (no-op). `targetId === null`
 * means "drop on Home" → reparent to top level.
 */
export function isValidLocationDrop(
  roots: InfLocation[],
  dragId: LocationShortcode,
  targetId: LocationShortcode | null,
): boolean {
  const unknown = findUnknownRoot(roots);
  if (unknown && dragId === unknown.id) return false;
  const currentParent = parentIdOf(roots, dragId);
  if (targetId === null) return currentParent !== null; // already top-level → no-op
  if (targetId === dragId) return false;
  if (currentParent === targetId) return false;
  return !isSelfOrDescendant(roots, dragId, targetId);
}

/** May the dragged item move to `targetLocationId`? Invalid only if it's a no-op. */
export function isValidItemDrop(
  sourceLocationId: LocationShortcode,
  targetLocationId: LocationShortcode,
): boolean {
  return sourceLocationId !== targetLocationId;
}

/** Immutable copy of `node` with `children` replaced (undefined children → []). */
function withChildren(node: InfLocation, children: InfLocation[]): InfLocation {
  return { ...node, children };
}

/**
 * Immutably move location `dragId` under `newParentId` (or to top level when
 * null). Removes it from its old parent's children (or the root list) and
 * appends it to the new parent's children (or the root list). Caller must have
 * already validated the move.
 */
export function applyLocationMove(
  roots: InfLocation[],
  dragId: LocationShortcode,
  newParentId: LocationShortcode | null,
): InfLocation[] {
  const moved = findNode(roots, dragId);
  if (!moved) return roots;

  // First remove the node everywhere it appears (it appears exactly once).
  const remove = (nodes: InfLocation[]): InfLocation[] =>
    nodes
      .filter((n) => n.id !== dragId)
      .map((n) => withChildren(n, remove(n.children ?? [])));

  const pruned = remove(roots);
  const relocated = withChildren(moved, moved.children ?? []);

  if (newParentId === null) {
    return [...pruned, relocated];
  }
  const insert = (nodes: InfLocation[]): InfLocation[] =>
    nodes.map((n) =>
      n.id === newParentId
        ? withChildren(n, [...(n.children ?? []), relocated])
        : withChildren(n, insert(n.children ?? [])),
    );
  return insert(pruned);
}

/** Immutable copy of `node` with `inventoryItems` replaced. */
function withItems(
  node: InfLocation,
  inventoryItems: InventoryItemForTree[],
): InfLocation {
  return { ...node, inventoryItems };
}

/**
 * Immutably move inventory item `itemId` from `sourceLocationId` to
 * `targetLocationId`. If the target already holds the same product the server
 * merges the rows — we don't try to sum amounts optimistically; the item just
 * appears at the target and the `onSettled` refetch reconciles the merge.
 * Caller must have already validated the move.
 */
export function applyItemMove(
  roots: InfLocation[],
  itemId: InventoryShortcode,
  sourceLocationId: LocationShortcode,
  targetLocationId: LocationShortcode,
): InfLocation[] {
  const source = findNode(roots, sourceLocationId);
  const item = source?.inventoryItems?.find((i) => i.id === itemId);
  if (!item) return roots;

  const transform = (nodes: InfLocation[]): InfLocation[] =>
    nodes.map((n) => {
      let next = n;
      if (n.id === sourceLocationId) {
        next = withItems(
          next,
          (next.inventoryItems ?? []).filter((i) => i.id !== itemId),
        );
      }
      if (n.id === targetLocationId) {
        next = withItems(next, [...(next.inventoryItems ?? []), item]);
      }
      return withChildren(next, transform(next.children ?? []));
    });

  return transform(roots);
}

/**
 * Children at the end of a Miller-columns `path`. Empty path → the root list.
 * `[a]` → children of a. Returns [] if any id in the path is missing.
 */
export function childrenOf(
  roots: InfLocation[],
  path: LocationShortcode[],
): InfLocation[] {
  let level = roots;
  for (const id of path) {
    const node = level.find((n) => n.id === id);
    if (!node) return [];
    level = node.children ?? [];
  }
  return level;
}
