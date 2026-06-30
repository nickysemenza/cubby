import type { Entity } from "@cubby/schemas/entity";
import { useLocation } from "@tanstack/react-router";
import { useMemo } from "react";
import { entities } from "~/entities/entities";

/** `/basePath` → entity, e.g. `/products` → "product". */
const ENTITY_BY_BASEPATH: ReadonlyArray<readonly [string, Entity]> =
  Object.entries(entities).map(
    ([entity, def]) => [`/${def.basePath}`, entity as Entity] as const,
  );

/**
 * The entity whose `basePath` is the longest matching segment-prefix of the
 * pathname (`/products/$id` → "product", `/ingredients/workbench` →
 * "ingredient"). Segment-boundary check so `/recipes-foo` can't match
 * `/recipes`. `undefined` for non-entity routes (settings, search, ask, …).
 * Mirrors `findActiveTo`'s longest-prefix match in nav-items.
 */
function entityForPath(pathname: string): Entity | undefined {
  let best: Entity | undefined;
  let bestLen = 0;
  for (const [base, entity] of ENTITY_BY_BASEPATH) {
    if (
      (pathname === base || pathname.startsWith(`${base}/`)) &&
      base.length > bestLen
    ) {
      best = entity;
      bestLen = base.length;
    }
  }
  return best;
}

/**
 * Derive the current route's {@link Entity} from the URL, so the page shell can
 * style the eyebrow/accent without every page passing `entity=` by hand. Used as
 * a fallback in {@link Page}; detail pages still pass `entity` explicitly (it's
 * TS-required there and drives the spec-plate).
 */
export function useRouteEntity(): Entity | undefined {
  const pathname = useLocation({ select: (l) => l.pathname });
  return useMemo(() => entityForPath(pathname), [pathname]);
}
