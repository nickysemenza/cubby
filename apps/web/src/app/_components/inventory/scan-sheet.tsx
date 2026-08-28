/**
 * The bottom-sheet shell every camera scanner wears.
 *
 * Three call sites had hand-rolled the same block — `Sheet` pinned to `bottom`,
 * close button suppressed, header, `PersistentScanner`, and a typed-code
 * fallback — with the props identical byte for byte. Those are constraints, not
 * choices: a 4:3 viewfinder in `ResponsiveSheet`'s desktop side rail is worse
 * than one at the bottom, and the sheet's own close button lands on top of the
 * torch control. Hence `Sheet` directly rather than the responsive wrapper.
 *
 * What it does NOT own, deliberately: when to close (a caller staying open for
 * a continuous sweep is the whole difference between this and a one-shot read),
 * what a scanned string MEANS, and how failures are reported. `LocationSweep`
 * composes the same pieces inline because it is a panel, not a sheet.
 */

import { type ReactNode, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";

import type { ScanFeedbackEntry } from "./persistent-scanner";
import { PersistentScanner } from "./persistent-scanner";
import type { BarcodeFormat } from "./useBarcodeScanner";

/**
 * A smudged label is a real failure mode, and this is also the only seam an
 * end-to-end test can drive — the camera cannot be. Labels are required rather
 * than defaulted: they are what the specs select on, so a shell-level default
 * would let a chrome refactor silently rename them.
 */
export function ScanManualEntry({
  ariaLabel,
  placeholder,
  submitLabel,
  disabled,
  onSubmit,
  className,
}: {
  ariaLabel: string;
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
  onSubmit: (raw: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState("");

  return (
    <Row
      as="form"
      align="center"
      gap="sm"
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        const raw = value.trim();
        if (!raw) return;
        setValue("");
        onSubmit(raw);
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        className="h-10 flex-1 text-xs sm:h-9"
        aria-label={ariaLabel}
      />
      <Button
        type="submit"
        variant="outline"
        className="min-h-10 px-3 text-xs sm:min-h-9" /* tight: manual scan fallback */
        disabled={disabled || value.trim().length === 0}
      >
        {submitLabel}
      </Button>
    </Row>
  );
}

export function ScanSheet({
  open,
  onOpenChange,
  title,
  description,
  formats,
  scanHintText,
  debounceMs,
  hudText,
  recentScans,
  onScan,
  manualEntry,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  formats: BarcodeFormat[];
  scanHintText: string;
  debounceMs?: number;
  hudText?: string;
  recentScans?: readonly ScanFeedbackEntry[];
  onScan: (raw: string) => void;
  /** Omit to offer camera only. */
  manualEntry?: Omit<
    Parameters<typeof ScanManualEntry>[0],
    "onSubmit" | "className"
  >;
  /** Rendered under the camera — review panels and the like. */
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="p-4" showCloseButton={false}>
        <SheetHeader className="p-0 pb-4">
          <SheetTitle>{title}</SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <Stack gap="sm">
          <PersistentScanner
            onScan={onScan}
            formatsToSupport={formats}
            scanHintText={scanHintText}
            debounceMs={debounceMs}
            hudText={hudText}
            recentScans={recentScans}
          />
          {manualEntry ? (
            <ScanManualEntry {...manualEntry} onSubmit={onScan} />
          ) : null}
          {children}
        </Stack>
      </SheetContent>
    </Sheet>
  );
}
