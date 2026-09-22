/**
 * Scan (or type) a location QR and hand the resolved location to the caller.
 *
 * A locations-domain primitive rather than a recount one: the recount session,
 * the photo pass, and anything else that starts from "which bin am I holding"
 * all need the same resolve-a-code sheet. `QrJumpButton` in the session's own
 * components wraps this with the in-session containment guard.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { locationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useQueryClient } from "@tanstack/react-query";
import { QrCode } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { QR_CODE_FORMATS } from "~/app/_components/inventory/persistent-scanner";
import { ScanSheet } from "~/app/_components/inventory/scan-sheet";
import { showErrorToast } from "~/components/feedback/error-details";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { resolveLocationScan } from "~/lib/scan-code";

/**
 * Bare-UUID fallback for the manual field. `resolveScanCode` deliberately
 * handles only labels and product codes, so a pasted raw uuid — which no QR
 * ever carries, but a debugging paste often does — lands here instead.
 */
function parseLocationIdFromInput(raw: string): LocationShortcode | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];

  try {
    const url = new URL(trimmed);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) candidates.push(lastSegment);
  }
  // SILENT: plain shortcode/UUID input (not a URL) is expected most of the
  // time; the candidates list below still tries the raw trimmed value.
  catch {}

  for (const candidate of candidates) {
    const parsed = locationShortcode.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  return null;
}

export function LocationScanButton({
  onResolved,
  buttonLabel = "Scan location",
  sheetDescription = "Open the scanned location's recount.",
  manualEntry = false,
  variant = "default",
}: {
  /**
   * Return `false` to keep the scanner sheet open — that is how a caller stays
   * in a scan loop, or rejects a code that is out of scope without losing the
   * camera. Any other return (including `undefined`) closes the sheet.
   */
  onResolved: (
    locationId: InfLocation["id"],
    shortcode: LocationShortcode | undefined,
    label?: string,
  ) => boolean | undefined;
  buttonLabel?: string;
  sheetDescription?: string;
  manualEntry?: boolean;
  variant?: "default" | "outline";
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const finish = (
    locationId: InfLocation["id"],
    shortcode: LocationShortcode | undefined,
    label?: string,
  ) => {
    const shouldClose = onResolved(locationId, shortcode, label) !== false;
    if (shouldClose) {
      setOpen(false);
      setManualValue("");
    }
  };

  const handleLocationInput = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const parsed = resolveLocationScan(raw);
    if (!parsed.ok) {
      const id = parseLocationIdFromInput(trimmed);
      if (id) {
        // A raw pasted UUID carries no shortcode — the caller degrades
        // gracefully (e.g. skips a direct URL jump) rather than us doing a
        // second network lookup just to backfill one.
        finish(id, undefined);
        return;
      }
      // A code for the wrong entity gets the shared sentence, which names what
      // was actually scanned. Only the catch-all is ours, because this field
      // accepts a form the shared helper deliberately knows nothing about.
      toast.error(
        parsed.reason === "wrong-kind"
          ? parsed.error
          : "Enter a location shortcode or UUID.",
      );
      return;
    }

    setIsResolving(true);
    try {
      const location = await queryClient.fetchQuery(
        entityDetailFor("location").queryOptions(parsed.value),
      );
      if (!location) {
        toast.error("No location found for that shortcode.");
        return;
      }
      finish(location.id, location.id, location.name);
    } catch (error) {
      showErrorToast(error, "Location lookup failed");
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
      <ScanSheet
        open={open}
        onOpenChange={setOpen}
        title="Scan location QR"
        description={sheetDescription}
        formats={QR_CODE_FORMATS}
        scanHintText="Point at location QR code"
        onScan={(value) => void handleLocationInput(value)}
        manualEntry={{
          ariaLabel: "Enter location shortcode or UUID",
          placeholder: "Can't scan? Shortcode / UUID",
          submitLabel: "Jump",
          disabled: isResolving,
        }}
      />
    </div>
  );
}
