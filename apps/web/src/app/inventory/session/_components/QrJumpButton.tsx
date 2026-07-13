import { unsafeLocationId } from "@cubby/schemas/identifiers";
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

export function QrJumpButton({
  parent,
  onJump,
  manualEntry = false,
}: {
  parent: InfLocation;
  onJump: (locationId: string) => void;
  manualEntry?: boolean;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const jumpToLocation = (targetId: string, label?: string) => {
    if (!isDescendantLocation(parent, targetId)) {
      // Out-of-root scan: not in this session, but offer to audit it directly
      // (a fresh session rooted there) instead of a dead end.
      toast(`${label ?? "That location"} is outside this session.`, {
        action: {
          label: "Audit it",
          onClick: () => {
            setOpen(false);
            setManualValue("");
            void navigate({
              to: "/inventory/session",
              search: { parentId: unsafeLocationId(targetId) },
            });
          },
        },
      });
      return false;
    }
    onJump(targetId);
    setOpen(false);
    setManualValue("");
    return true;
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
      jumpToLocation(id);
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
      jumpToLocation(location.id, location.name);
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
        variant="outline"
        className="min-h-12 px-4"
        onClick={() => setOpen(true)}
      >
        <QrCode className="h-4 w-4" />
        Scan location
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Scan location QR</SheetTitle>
            <SheetDescription>
              Jump to a location in this session.
            </SheetDescription>
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
