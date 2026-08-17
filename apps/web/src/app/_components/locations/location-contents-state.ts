export interface LocationContentsVisibility {
  empty: boolean;
  showChildren: boolean;
  showDirectItems: boolean;
}

/** Keep descendant structure visible without inventing direct stock. */
export function locationContentsVisibility(
  childCount: number,
  directItemCount: number,
): LocationContentsVisibility {
  const showChildren = childCount > 0;
  const showDirectItems = directItemCount > 0;
  return {
    empty: !showChildren && !showDirectItems,
    showChildren,
    showDirectItems,
  };
}
