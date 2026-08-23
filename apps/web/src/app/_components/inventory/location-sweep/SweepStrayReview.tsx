/**
 * The end-of-sweep decision. One panel, one primary action.
 *
 * This is the answer to the sixty-tap problem: nothing interrupts the camera
 * while you work, and every product that turned up somewhere else collects
 * here. Single-unit rows — books, tools, most one-offs — move whole on one tap.
 * Only a row holding more than one unit asks anything, because a scan proves
 * one object moved, not five.
 */

import type { ScanStrayOut } from "@cubby/schemas/scan";
import { ArrowDownToLine, X } from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { tryFormatAmount } from "../format-amount";
import type { QueuedStray } from "./useLocationSweep";

/** Move just the one object the scan actually accounted for. */
const ONE_UNIT = (row: ScanStrayOut) => ({ value: 1, unit: row.amount.unit });

export function SweepStrayReview({
  strays,
  locationName,
  committing,
  onCommit,
  onDismiss,
}: {
  strays: QueuedStray[];
  locationName: string;
  committing: boolean;
  onCommit: (
    quantities: Record<string, { value: number; unit: string }>,
  ) => void;
  onDismiss: (productId: string) => void;
}) {
  // Entry ids the user chose to move partially. Absent means "move the row".
  const [partial, setPartial] = useState<Record<string, true>>({});

  if (strays.length === 0) return null;

  const rowCount = strays.reduce((n, stray) => n + stray.rows.length, 0);

  return (
    <Stack gap="sm" className="border-t-[3px] border-t-foreground pt-4">
      <Stack gap="tight">
        <span className="font-mono text-[0.625rem] text-slate uppercase tracking-[0.05em]">
          Living elsewhere
        </span>
        <Description>
          {rowCount === 1
            ? "1 scanned item is on record somewhere else."
            : `${rowCount} scanned items are on record somewhere else.`}{" "}
          Moving them here says this shelf is where they live now.
        </Description>
      </Stack>

      <Stack gap="xs" className="max-h-64 overflow-auto">
        {strays.map((stray) =>
          stray.rows.map((row) => {
            const isPartial = partial[row.entryId] === true;
            return (
              <Row
                key={row.entryId}
                align="center"
                gap="sm"
                className="min-w-0 border border-[var(--border)] p-2"
              >
                <Stack gap="tight" className="min-w-0 flex-1">
                  <span className="truncate text-xs">{stray.productName}</span>
                  <span className="truncate font-mono text-[0.625rem] text-slate">
                    {tryFormatAmount(row.amount)} · {row.location.name}
                  </span>
                </Stack>

                {/* Only a multi-unit row is genuinely ambiguous; asking about a
                    single copy would be the tap tax this panel exists to avoid. */}
                {row.ambiguousQuantity && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 shrink-0 px-2 text-[0.625rem]"
                    onClick={() =>
                      setPartial((prev) => {
                        const next = { ...prev };
                        if (isPartial) delete next[row.entryId];
                        else next[row.entryId] = true;
                        return next;
                      })
                    }
                  >
                    {isPartial
                      ? `Move 1 ${row.amount.unit}`
                      : `Move all ${tryFormatAmount(row.amount)}`}
                  </Button>
                )}

                <Button
                  type="button"
                  variant="ghost"
                  className="size-8 shrink-0"
                  title={`Leave ${stray.productName} where it is`}
                  aria-label={`Leave ${stray.productName} where it is`}
                  onClick={() => onDismiss(stray.productId)}
                >
                  <X className="size-4" />
                </Button>
              </Row>
            );
          }),
        )}
      </Stack>

      <Button
        type="button"
        className="min-h-12"
        disabled={committing}
        onClick={() =>
          onCommit(
            Object.fromEntries(
              strays.flatMap((stray) =>
                stray.rows
                  .filter((row) => partial[row.entryId] === true)
                  .map((row) => [row.entryId, ONE_UNIT(row)] as const),
              ),
            ),
          )
        }
      >
        {committing ? <Spinner /> : <ArrowDownToLine className="size-4" />}
        Move {rowCount === 1 ? "it" : `all ${rowCount}`} into {locationName}
      </Button>
    </Stack>
  );
}
