import type { InfLocation, LocationType } from "@cubby/schemas/location";

export function indexLocations(locations: InfLocation[]) {
  const byId = new Map<string, InfLocation>();
  const parents = new Map<string, string>();
  const branchIds = new Set<string>();
  const initiallyExpanded = new Set<string>();
  const visit = (nodes: InfLocation[], parent?: string) => {
    for (const node of nodes) {
      byId.set(node.id, node);
      if (parent) parents.set(node.id, parent);
      else initiallyExpanded.add(node.id);
      if (node.children?.length || node.inventoryItems?.length)
        branchIds.add(node.id);
      visit(node.children ?? [], node.id);
    }
  };
  visit(locations);
  return { byId, parents, branchIds, initiallyExpanded };
}

export function locationPath(
  id: string | undefined,
  index: ReturnType<typeof indexLocations>,
) {
  const path: InfLocation[] = [];
  let node = id ? index.byId.get(id) : undefined;
  while (node) {
    path.unshift(node);
    const parent = index.parents.get(node.id);
    node = parent ? index.byId.get(parent) : undefined;
  }
  return path;
}

/** Keep matches and their lineage, never every descendant of a named match. */
export function filterLocationTree(
  locations: InfLocation[],
  {
    query = "",
    type = null,
    status = "all",
    includeInventory = true,
  }: {
    query?: string;
    type?: LocationType | null;
    status?: "all" | "withItems" | "empty";
    includeInventory?: boolean;
  },
) {
  const term = query.trim().toLocaleLowerCase();
  const active = Boolean(term || type || status !== "all");
  const totals = new Map<string, number>();
  const visit = (nodes: InfLocation[]): InfLocation[] =>
    nodes.flatMap((node) => {
      const children = visit(node.children ?? []);
      const directItemCount =
        node.directItemCount ?? node.inventoryItems?.length ?? 0;
      // Filtered-out descendants still contribute to a location's rollup.
      const totalItemCount =
        node.totalItemCount ??
        directItemCount +
          (node.children ?? []).reduce(
            (sum, child) => sum + (totals.get(child.id) ?? 0),
            0,
          );
      totals.set(node.id, totalItemCount);
      const inventoryItems = term
        ? (node.inventoryItems ?? []).filter(
            (item) =>
              includeInventory &&
              item.productName.toLocaleLowerCase().includes(term),
          )
        : node.inventoryItems;
      const hasItems = directItemCount > 0;
      const matches =
        (!type || node.type === type) &&
        (status === "all" || (status === "withItems" ? hasItems : !hasItems)) &&
        (!term ||
          node.name.toLocaleLowerCase().includes(term) ||
          Boolean(inventoryItems?.length));
      if (!matches && children.length === 0) return [];
      return !active &&
        node.directItemCount !== undefined &&
        node.totalItemCount !== undefined &&
        children.every((child, index) => child === node.children?.[index])
        ? [node]
        : [
            {
              ...node,
              children,
              inventoryItems,
              directItemCount,
              totalItemCount,
            },
          ];
    });
  return { locations: visit(locations), active };
}
