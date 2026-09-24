/**
 * The end-of-sweep decision. One panel, one primary action.
 *
 * This is the answer to the sixty-tap problem: nothing interrupts the camera
 * while you work, and everything that turned up somewhere else collects here —
 * items and bins alike, committed together by one button even though they land
 * through two mutations. Single-unit rows — books, tools, most one-offs — move
 * whole on one tap. Only a row holding more than one unit asks anything,
 * because a scan proves one object moved, not five. A bin has no quantity at
 * all, so it never asks.
 */

import type { ScanStrayOut } from "@cubby/schemas/scan";
import { ArrowLineDownIcon as ArrowDownToLine } from "@phosphor-icons/react/dist/csr/ArrowLineDown";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { useState } from "react";

import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";

import { tryFormatAmount } from "../format-amount";
import type { QueuedBin } from "./sweep-bin-plan";
import type { QueuedStray } from "./useLocationSweep";

/** Move just the one object the scan actually accounted for. */
const ONE_UNIT = (row: ScanStrayOut) => ({ value: 1, unit: row.amount.unit });

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Section labels earn their place only when both kinds are queued. With one
 * kind the panel reads exactly as it always has.
 */
function GroupLabel({ show, children }: { show: boolean; children: string }) {
  if (!show) return null;
  return (
    <span className="font-mono text-[0.625rem] tracking-[0.05em] text-slate uppercase">
      {children}
    </span>
  );
}

export function SweepStrayReview({
  strays,
  bins,
  locationName,
  committing,
  onCommit,
  onDismiss,
  onDismissBin,
}: {
  strays: QueuedStray[];
  bins: QueuedBin[];
  locationName: string;
  committing: boolean;
  onCommit: (
    quantities: Record<string, { value: number; unit: string }>,
  ) => void;
  onDismiss: (productId: string) => void;
  onDismissBin: (binId: string) => void;
}) {
  // Entry ids the user chose to move partially. Absent means "move the row".
  const [partial, setPartial] = useState<Record<string, true>>({});

  if (strays.length === 0 && bins.length === 0) return null;

  const rowCount = strays.reduce((n, stray) => n + stray.rows.length, 0);
  const total = rowCount + bins.length;
  const bothKinds = rowCount > 0 && bins.length > 0;
  const subject = [
    rowCount > 0 ? plural(rowCount, "scanned item") : null,
    bins.length > 0 ? plural(bins.length, "bin") : null,
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <Stack gap="sm" className="border-t border-t-foreground pt-4">
      <Stack gap="tight">
        <span className="font-mono text-[0.625rem] tracking-[0.05em] text-slate uppercase">
          Living elsewhere
        </span>
        <Description>
          {subject} {total === 1 ? "is" : "are"} on record somewhere else.
          Moving {total === 1 ? "it" : "them"} here says this shelf is where{" "}
          {total === 1 ? "it lives" : "they live"} now.
        </Description>
      </Stack>

      <Stack gap="xs" className="max-h-64 overflow-auto">
        <GroupLabel show={bothKinds}>Bins</GroupLabel>
        {bins.map((bin) => (
          <Row
            key={bin.id}
            align="center"
            gap="sm"
            className="min-w-0 border border-[var(--border)] p-2"
          >
            <LocationIcon type={bin.type} product={null} size={14} />
            <Stack gap="tight" className="min-w-0 flex-1">
              <span className="truncate text-xs">{bin.name}</span>
              <span className="truncate font-mono text-[0.625rem] text-slate">
                in {bin.currentParentName}
              </span>
            </Stack>
            {/* No quantity control: a bin is singular, and its contents ride
                along with it. */}
            <Button
              type="button"
              variant="ghost"
              className="size-8 shrink-0"
              title={`Leave ${bin.name} where it is`}
              aria-label={`Leave ${bin.name} where it is`}
              onClick={() => onDismissBin(bin.id)}
            >
              <X className="size-4" />
            </Button>
          </Row>
        ))}

        <GroupLabel show={bothKinds}>Items</GroupLabel>
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
        Move {total === 1 ? "it" : `all ${total}`} into {locationName}
      </Button>
    </Stack>
  );
}
