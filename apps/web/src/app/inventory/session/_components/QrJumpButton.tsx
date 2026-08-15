import type { InfLocation } from "@cubby/schemas/location";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { LocationScanButton } from "~/app/_components/locations/location-scan-button";
import { isDescendantLocation } from "../session-utils";

/**
 * The recount's scan button: {@link LocationScanButton} plus the containment
 * guard. A code outside the current pass is not an error — it is usually the
 * cue to switch passes — so it offers that as a toast action and returns
 * `false` to keep the scanner open.
 */
export function QrJumpButton({
  parent,
  onJump,
  manualEntry = false,
}: {
  parent: InfLocation;
  onJump: (locationId: string) => void;
  manualEntry?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <LocationScanButton
      variant="outline"
      manualEntry={manualEntry}
      sheetDescription="Jump within this recount, or switch to the scanned location."
      onResolved={(targetId, shortcode, label) => {
        if (!isDescendantLocation(parent, targetId)) {
          toast(`${label ?? "That location"} is outside this recount.`, {
            action: {
              label: "Switch recount",
              onClick: () => {
                void navigate({
                  to: "/inventory/session",
                  search: { parent: shortcode },
                });
              },
            },
          });
          return false;
        }
        onJump(targetId);
        return true;
      }}
    />
  );
}
