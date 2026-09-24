/**
 * What the sweep did not see — bins only, and only when asked.
 *
 * A sweep is casual and partial by design: it works on an empty shelf and you
 * can stop halfway, so absence can never be inferred from a pass on its own.
 * This panel appears behind an explicit "I got everything", which is the same
 * bargain the recount makes when it closes the world over stock.
 *
 * Every repair is a per-row choice. Nothing here writes because something was
 * not scanned.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { QuestionIcon as CircleHelp } from "@phosphor-icons/react/dist/csr/Question";

import {
  DestinationLocationField,
  resolveDestination,
  useDestinationLocationForm,
} from "~/app/_components/inventory/destination-location-picker";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

import type { MissingBin } from "./useLocationSweep";

function MissingRow({
  bin,
  sweptLocationId,
  onRelocate,
  onSendToUnknown,
  busy,
}: {
  bin: MissingBin;
  sweptLocationId: LocationShortcode;
  onRelocate: (binId: string, parentId: string) => void;
  onSendToUnknown: (binId: string) => void;
  busy: boolean;
}) {
  // The fourth "choose a target location" surface, after the two move dialogs
  // and bulk move. Passing the swept location as the source is what disables
  // it in the list: a bin cannot be relocated to where it already isn't.
  const { form, error, setError } = useDestinationLocationForm();

  return (
    <Stack gap="xs" className="border border-[var(--border)] p-2">
      <Row align="center" gap="sm" className="min-w-0">
        <LocationIcon type={bin.type} product={null} size={14} />
        <span className="min-w-0 flex-1 truncate text-xs">{bin.name}</span>
        <span className="shrink-0 font-mono text-[0.625rem] text-slate">
          {bin.id}
        </span>
      </Row>
      <Row align="end" gap="sm" className="min-w-0">
        <div className="min-w-0 flex-1">
          <DestinationLocationField
            form={form}
            name="targetLocation"
            label="Move to"
            error={error}
            sourceLocationIds={sweptLocationId}
          />
        </div>
        <Button
          type="button"
          className="min-h-10 shrink-0 px-3 text-xs" /* tight: inline with the picker */
          disabled={busy}
          onClick={() => {
            const target = resolveDestination(
              form.getValues("targetLocation"),
              sweptLocationId,
              {
                missingTarget: "Pick where it went.",
                sameAsSource: "That's the shelf you just swept.",
              },
            );
            if (!target.ok) {
              setError(target.error);
              return;
            }
            setError(null);
            onRelocate(bin.id, target.id);
          }}
        >
          Move
        </Button>
        {/* For "it's not here and I don't know where" — the same parking spot
            the recount drains. */}
        <Button
          type="button"
          variant="outline"
          className="min-h-10 shrink-0 px-3 text-xs" /* tight: inline with the picker */
          disabled={busy}
          onClick={() => onSendToUnknown(bin.id)}
        >
          Unknown
        </Button>
      </Row>
    </Stack>
  );
}

export function SweepMissingReview({
  missing,
  locationName,
  hasItems,
  locationId,
  busy,
  onRelocate,
  onSendToUnknown,
}: {
  /** `null` until the user asks. Empty means asked, and nothing was absent. */
  missing: MissingBin[] | null;
  locationName: string;
  hasItems: boolean;
  locationId: LocationShortcode;
  busy: boolean;
  onRelocate: (binId: string, parentId: string) => void;
  onSendToUnknown: (binId: string) => void;
}) {
  if (missing === null) return null;

  return (
    <Stack gap="sm" className="border-t border-t-foreground pt-4">
      <Stack gap="tight">
        <span className="font-mono text-[0.625rem] tracking-[0.05em] text-slate uppercase">
          Not seen
        </span>
        <Description>
          {missing.length === 0
            ? `Every bin on ${locationName} was accounted for.`
            : `${missing.length === 1 ? "1 bin sits" : `${missing.length} bins sit`} on ${locationName} on record, but nothing scanned ${missing.length === 1 ? "it" : "them"}.`}
          {/* Silence would read as "nothing else is missing", which is false —
              the sweep only ever closes the world over bins. */}
          {hasItems ? " Items aren't checked here — a recount does that." : ""}
        </Description>
      </Stack>

      {missing.length > 0 && (
        <Stack gap="xs" className="max-h-64 overflow-auto">
          {missing.map((bin) => (
            <MissingRow
              key={bin.id}
              bin={bin}
              sweptLocationId={locationId}
              busy={busy}
              onRelocate={onRelocate}
              onSendToUnknown={onSendToUnknown}
            />
          ))}
        </Stack>
      )}

      {hasItems && (
        <Button
          variant="outline"
          className="min-h-10 self-start px-3 text-xs" /* tight: a footnote link, not a primary action */
          render={
            <a href={`/inventory/session?parent=${locationId}`}>
              <CircleHelp className="size-4" />
              Recount the items too
            </a>
          }
        />
      )}
    </Stack>
  );
}
