import { Keyboard, ScanBarcode } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import {
  PersistentScanner,
  UNIVERSAL_SCAN_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import { Stack } from "~/components/layout";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import type { ResolvedScanCode } from "~/lib/scan-code";
import { resolveScanCode } from "~/lib/scan-code";

interface ScanWorkbenchProps {
  onResolve: (value: ResolvedScanCode) => Promise<void>;
}

/** Camera and keyboard entry for the same one-code-at-a-time navigation job. */
export function ScanWorkbench({ onResolve }: ScanWorkbenchProps) {
  const inputId = useId();
  const helpId = useId();
  const resolvingRef = useRef(false);
  const [manualValue, setManualValue] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const openValue = useCallback(
    async (raw: string) => {
      if (resolvingRef.current) return;

      const result = resolveScanCode(raw);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      resolvingRef.current = true;
      setResolving(true);
      setError(null);
      try {
        await onResolve(result.value);
      } catch (cause) {
        setError(`Could not open that code. ${getErrorMessage(cause)}`);
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [onResolve],
  );

  return (
    <Stack gap="sm" className="w-full md:mx-auto md:max-w-2xl">
      <div className="flex min-h-11 items-center justify-between border-border border-b px-2 md:border">
        <Description size="xs">
          Camera ready for Cubby and product codes
        </Description>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 shrink-0"
          onClick={() => setManualOpen(true)}
        >
          <Keyboard className="size-4" />
          Enter code
        </Button>
      </div>

      {error && !manualOpen && (
        <Alert variant="destructive">
          <AlertTitle>Code not opened</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {resolving ? (
        <div
          className="flex h-[calc(100dvh-var(--app-chrome-top)-var(--app-chrome-bottom)-3rem)] w-full items-center justify-center border border-border bg-black text-white md:aspect-[4/3] md:h-auto"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 text-sm">
            <Spinner />
            Looking up code…
          </div>
        </div>
      ) : (
        <PersistentScanner
          onScan={(value) => void openValue(value)}
          onError={(message) => setError(`Camera unavailable. ${message}`)}
          formatsToSupport={UNIVERSAL_SCAN_FORMATS}
          scanHintText="Point at a Cubby label or product barcode"
        />
      )}

      <ResponsiveSheet
        open={manualOpen}
        onOpenChange={setManualOpen}
        title="Enter a code"
        description="Open a Cubby record or look up a product without the camera."
      >
        <Stack
          as="form"
          gap="sm"
          onSubmit={(event) => {
            event.preventDefault();
            void openValue(manualValue);
          }}
        >
          <Label htmlFor={inputId}>Code</Label>
          <Input
            id={inputId}
            value={manualValue}
            onChange={(event) => setManualValue(event.target.value)}
            placeholder="Shortcode, UPC, or ISBN"
            aria-describedby={helpId}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 font-mono"
          />
          <Description id={helpId} size="xs">
            Cubby QR label, entity shortcode, UPC/EAN/GTIN barcode, or
            ISBN-10/13.
          </Description>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Code not opened</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={resolving || manualValue.trim().length === 0}
          >
            {resolving ? <Spinner /> : <ScanBarcode className="size-4" />}
            Open
          </Button>
        </Stack>
      </ResponsiveSheet>
    </Stack>
  );
}
