import type { InfLocation } from "@cubby/schemas/location";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { LocationScanButton } from "~/app/_components/locations/location-scan-button";

import { classifyScannedLocation } from "../session-utils";

/**
 * The recount's location-QR button: {@link LocationScanButton} plus what a
 * scanned bin means from where you are standing.
 *
 * Four outcomes, and every one of them returns `false` so the camera survives.
 * Sweeping a rack of bin labels has to be repeatable without reopening the
 * sheet — that is the second half of the job this button exists for.
 */
export function QrJumpButton({
  parent,
  current,
  onJump,
  onAdopt,
  manualEntry = false,
}: {
  /** The recount's root — the tree the classification is read against. */
  parent: InfLocation;
  /** The bin being recounted right now, or null before a stop is chosen. */
  current: InfLocation | null;
  onJump: (locationId: string) => void;
  /** Re-parent a stray bin into the current one. */
  onAdopt: (location: Pick<InfLocation, "id" | "name">) => void;
  manualEntry?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <LocationScanButton
      variant="outline"
      manualEntry={manualEntry}
      sheetDescription="Jump within this recount, or pull a stray bin in here."
      onResolved={(targetId, shortcode, label) => {
        const name = label ?? "That location";
        const switchAction = shortcode
          ? {
              label: "Switch recount",
              onClick: () => {
                void navigate({
                  to: "/inventory/session",
                  search: { parent: shortcode },
                });
              },
            }
          : undefined;

        if (!current) {
          onJump(targetId);
          return false;
        }

        switch (classifyScannedLocation(parent, current, targetId)) {
          case "current":
            toast.info(`You're already at ${current.name}.`);
            return false;

          case "inside":
            // Already under this bin. Jumping is only meaningful if it is a
            // stop in the frozen pass; the caller reports it if not.
            onJump(targetId);
            return false;

          case "ancestor":
            // The server would refuse this anyway (LOCATION_CYCLE_DETECTED);
            // saying so here avoids rendering a button that can only fail.
            toast.error(
              `${name} contains ${current.name} — it can't move inside it.`,
              switchAction ? { action: switchAction } : undefined,
            );
            return false;

          default: {
            // The case the bin sweep exists for: a bin that ended up somewhere
            // else. Offer to pull it in rather than only offering to leave.
            toast(`${name} lives elsewhere.`, {
              action: {
                label: `Move into ${current.name}`,
                onClick: () => onAdopt(adoptTarget(parent, targetId, name)),
              },
              ...(switchAction ? { cancel: switchAction } : {}),
            });
            return false;
          }
        }
      }}
    />
  );
}

/**
 * The scanned node as it exists in the session tree, so the caller can read its
 * current parent before re-parenting it — undo has to restore where it actually
 * was, not a hardcoded fallback.
 */
function adoptTarget(
  parent: InfLocation,
  targetId: InfLocation["id"],
  name: string,
): Pick<InfLocation, "id" | "name"> {
  const found = findInTree(parent, targetId);
  return found ?? { id: targetId, name };
}

function findInTree(node: InfLocation, id: string): InfLocation | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findInTree(child, id);
    if (hit) return hit;
  }
  return null;
}
