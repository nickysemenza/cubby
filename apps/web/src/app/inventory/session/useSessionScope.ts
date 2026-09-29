import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useMemo } from "react";

import { useProductViewSnapshot } from "../worklist/useProductViewSnapshot";
import {
  locationIdsHoldingProducts,
  type RecountWorklist,
  WORKLIST_TITLES,
  worklistScopeKey,
} from "../worklist/worklist-locations";
import {
  findLocationInTreeByShortcode,
  flattenAuditableLocations,
  sessionLocationsForIds,
} from "./session-utils";

/** What a pass walks: a location's subtree, or a worklist across the tree. */
export interface SessionScope {
  title: string;
  /** The tree breadcrumbs and scanned-bin classification are read from. */
  roots: InfLocation[];
  worklist: RecountWorklist | null;
}

/**
 * Resolve the session's entry parameters to the stops it will walk.
 *
 * A worklist's product set is read once and held for the whole pass (see
 * `useProductViewSnapshot`), then resolved to the locations holding those
 * products' stock; entering with a `worklist` never consults the parent.
 * `rootId` keys the persisted pass: a worklist's is keyed by the worklist, never
 * a location, so its resume entry cannot collide with (or be mistaken for) a
 * recount rooted at a real location.
 */
export function useSessionScope({
  tree,
  initialParentShortcode,
  worklist,
}: {
  tree: InfLocation[] | undefined;
  initialParentShortcode: LocationShortcode | undefined;
  worklist: RecountWorklist | undefined;
}) {
  const parent = useMemo(
    () =>
      worklist
        ? null
        : findLocationInTreeByShortcode(tree, initialParentShortcode),
    [tree, initialParentShortcode, worklist],
  );

  const worklistSnapshot = useProductViewSnapshot({
    viewId: worklist ?? "shelf-disagrees",
    enabled: worklist !== undefined,
  });
  const worklistLocationIds = useMemo(
    () =>
      worklistSnapshot.data
        ? locationIdsHoldingProducts(worklistSnapshot.data)
        : null,
    [worklistSnapshot.data],
  );

  const sessionLocations = useMemo(() => {
    if (worklist) {
      return tree && worklistLocationIds
        ? sessionLocationsForIds(tree, worklistLocationIds)
        : [];
    }
    return parent ? flattenAuditableLocations(parent) : [];
  }, [parent, tree, worklist, worklistLocationIds]);

  const scope = useMemo((): SessionScope | null => {
    if (worklist) {
      return tree && worklistLocationIds
        ? { title: WORKLIST_TITLES[worklist], roots: tree, worklist }
        : null;
    }
    return parent
      ? { title: parent.name, roots: [parent], worklist: null }
      : null;
  }, [parent, tree, worklist, worklistLocationIds]);

  const rootId = worklist
    ? scope
      ? worklistScopeKey(worklist)
      : null
    : (parent?.id ?? null);

  const worklistFailure =
    worklist && worklistSnapshot.isError
      ? {
          title: `Couldn't load the ${WORKLIST_TITLES[worklist]} worklist`,
          error: worklistSnapshot.error,
          onRetry: () => void worklistSnapshot.refetch(),
        }
      : null;

  return {
    sessionLocations,
    scope,
    rootId,
    worklistLoading: worklist !== undefined && worklistSnapshot.isLoading,
    worklistFailure,
  };
}
