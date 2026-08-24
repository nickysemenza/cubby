/**
 * What a scanned bin label means from the location being swept.
 *
 * Pure: two locations in, a verdict out. No DB, no tRPC, no clock — the hook
 * gathers the facts and acts on the verdict.
 *
 * Membership is DIRECT-only, matching the product half: `planScan` compares
 * location by exact id, so stock inside a child bin has always been a stray
 * rather than "here". A bin follows the same rule, which is why a grandchild
 * is offered for promotion instead of silently confirmed.
 *
 * Read off two `.parent` chains rather than a tree. Neither sweep mount point
 * has a location tree in scope, and the recount's tree carries none anyway —
 * `buildLocationTree` builds its nodes with `includeParent = false`. The chain
 * comes free with the Location detail record both scans already need.
 */

import type { InfLocation } from "@cubby/schemas/location";
import {
  getLocationTypeGroup,
  typeSupportsQrCode,
} from "~/app/_components/locations/location-type-theme";

/**
 * The subset of a location this module reasons about.
 *
 * Declared recursively rather than as a `Pick` of `InfLocation` so a caller can
 * hand it two chains without materialising whole locations — and so the tests
 * read as trees instead of fixtures. `InfLocation` satisfies it structurally.
 */
export interface SweepBinNode {
  id: InfLocation["id"];
  name: string;
  type?: InfLocation["type"];
  parent?: SweepBinNode;
}

/**
 * One bin that turned up during a sweep and is not a direct child of the
 * location being swept. Keyed by shortcode: scanning the same label twice
 * queues one decision, the same property `QueuedStray` gets from its product.
 */
export interface QueuedBin {
  id: InfLocation["id"];
  name: string;
  /** Carried for the review row's glyph, not for any decision here. */
  type: InfLocation["type"];
  /** Where it sits now — the sentence the review row reads out. */
  currentParentName: string;
}

export type SweepBinVerdict =
  /** Already a direct child. Nothing is written — see the sweep's tally copy. */
  | { kind: "confirm" }
  /** Lives elsewhere. Queues for the end-of-sweep commit. */
  | { kind: "adopt"; bin: QueuedBin }
  | { kind: "refuse"; reason: "self" | "home" | "ancestor"; message: string };

/** Ids from the root down to (and excluding) the node itself. */
function ancestorIdsOf(node: SweepBinNode): Set<InfLocation["id"]> {
  const ids = new Set<InfLocation["id"]>();
  let current = node.parent;
  while (current) {
    ids.add(current.id);
    current = current.parent;
  }
  return ids;
}

/**
 * Order is load-bearing. `home` is checked before `ancestor` because Home is an
 * ancestor of very nearly everything, and "it holds the whole house" is the
 * sentence that actually explains the refusal.
 */
export function planSweptBin(
  anchor: SweepBinNode,
  target: SweepBinNode,
): SweepBinVerdict {
  if (target.id === anchor.id) {
    return {
      kind: "refuse",
      reason: "self",
      message: `That's ${anchor.name} — the one you're sweeping.`,
    };
  }

  // Home is the single live parentless location, asserted at the repository
  // boundary (see getHomeLocation), so a missing parent identifies it without
  // a second lookup.
  if (!target.parent) {
    return {
      kind: "refuse",
      reason: "home",
      message: `${target.name} holds the whole house — it can't sit on a shelf.`,
    };
  }

  if (target.parent.id === anchor.id) {
    return { kind: "confirm" };
  }

  if (ancestorIdsOf(anchor).has(target.id)) {
    return {
      kind: "refuse",
      reason: "ancestor",
      message: `${target.name} contains ${anchor.name} — it can't move inside it.`,
    };
  }

  return {
    kind: "adopt",
    bin: {
      id: target.id,
      name: target.name,
      type: target.type ?? null,
      currentParentName: target.parent.name,
    },
  };
}

/**
 * Can this child be reported missing from a sweep of its parent?
 *
 * Two facts, both derived from type today. It must be able to carry a QR
 * sticker — you cannot fail to scan what was never scannable. And it must be
 * the kind of thing that physically leaves: only containers travel between
 * parents. Drawers and shelves are part of the furniture they hang in, so
 * sweeping a tool cart must never report its drawers as gone.
 *
 * The mobility half is a heuristic standing in for a per-location fact. The
 * exact model is `InventoryEntry.placement: "installed"` one table over; if
 * this misfires, replace this branch with a Location column rather than
 * widening the type groups.
 */
export function canGoMissing(child: Pick<InfLocation, "type">): boolean {
  if (!typeSupportsQrCode(child.type)) return false;
  return getLocationTypeGroup(child.type) === "containers";
}
