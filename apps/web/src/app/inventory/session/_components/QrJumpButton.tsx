import type { InfLocation } from "@cubby/schemas/location";
import { extractShortcodeFromScan } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { QrCode } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  PersistentScanner,
  QR_CODE_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  isDescendantLocation,
  parseLocationIdFromInput,
} from "../session-utils";

export function LocationScanButton({
  onResolved,
  buttonLabel = "Scan location",
  sheetDescription = "Open the scanned location's recount.",
  manualEntry = false,
  variant = "default",
}: {
  onResolved: (
    locationId: InfLocation["id"],
    label?: string,
  ) => boolean | undefined;
  buttonLabel?: string;
  sheetDescription?: string;
  manualEntry?: boolean;
  variant?: "default" | "outline";
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const finish = (locationId: InfLocation["id"], label?: string) => {
    const shouldClose = onResolved(locationId, label) !== false;
    if (shouldClose) {
      setOpen(false);
      setManualValue("");
    }
  };

  const handleLocationInput = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const parsed = extractShortcodeFromScan(raw);
    if (!parsed) {
      const id = parseLocationIdFromInput(trimmed);
      if (!id) {
        toast.error("Enter a location shortcode or UUID.");
        return;
      }
      finish(id);
      return;
    }

    if (parsed.type !== "location") {
      toast.error("Not a location code.");
      return;
    }

    setIsResolving(true);
    try {
      const location = await queryClient.fetchQuery(
        api.location.getByShortcode.queryOptions({
          shortcode: parsed.shortcode,
        }),
      );
      if (!location) {
        toast.error("No location found for that shortcode.");
        return;
      }
      finish(location.id, location.name);
    } catch (error) {
      toast.error(`Location lookup failed: ${getErrorMessage(error)}`);
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {manualEntry && (
        <form
          className="hidden items-center gap-1 lg:flex"
          onSubmit={(event) => {
            event.preventDefault();
            void handleLocationInput(manualValue);
          }}
        >
          <Input
            value={manualValue}
            onChange={(event) => setManualValue(event.target.value)}
            placeholder="Shortcode / UUID"
            className="h-9 w-44 text-xs"
            aria-label="Paste location shortcode or UUID"
          />
          <Button
            type="submit"
            variant="outline"
            className="min-h-9 px-3 text-xs" /* tight: desktop jump form */
            disabled={isResolving || manualValue.trim().length === 0}
          >
            Jump
          </Button>
        </form>
      )}
      <Button
        type="button"
        variant={variant}
        className="min-h-12 px-4"
        onClick={() => setOpen(true)}
      >
        <QrCode className="size-4" />
        {buttonLabel}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Scan location QR</SheetTitle>
            <SheetDescription>{sheetDescription}</SheetDescription>
          </SheetHeader>
          <PersistentScanner
            onScan={(value) => void handleLocationInput(value)}
            formatsToSupport={QR_CODE_FORMATS}
            scanHintText="Point at location QR code"
          />
          <Row
            as="form"
            align="center"
            gap="sm"
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLocationInput(manualValue);
            }}
          >
            <Input
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              placeholder="Can't scan? Shortcode / UUID"
              className="h-9 flex-1 text-xs"
              aria-label="Enter location shortcode or UUID"
            />
            <Button
              type="submit"
              variant="outline"
              className="min-h-9 px-3 text-xs" /* tight: manual jump fallback */
              disabled={isResolving || manualValue.trim().length === 0}
            >
              Jump
            </Button>
          </Row>
        </SheetContent>
      </Sheet>
    </div>
  );
}

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
      onResolved={(targetId, label) => {
        if (!isDescendantLocation(parent, targetId)) {
          toast(`${label ?? "That location"} is outside this recount.`, {
            action: {
              label: "Switch recount",
              onClick: () => {
                void navigate({
                  to: "/inventory/session",
                  search: { parentId: targetId },
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
