/**
 * Walk a queue of locations taking one photo each.
 *
 * Three ways in, all landing on the same stop screen:
 *  - **scoped** — every descendant of a chosen parent (`location.subtree`)
 *  - **house** — the whole forest's missing-photo backlog (`location.makeTree`)
 *  - **scan** — no queue; a QR scan names the stop, then the scanner reopens
 *
 * Unlike the recount session there is nothing staged and nothing to resume:
 * every photo commits the moment it is taken, so progress lives in memory and
 * the source of truth is the data itself. That is also why the queue's
 * *membership* is frozen per scope (see `frozenQueue` below) while its
 * *contents* stay live — without the freeze, photographing a location would
 * drop it from the default filter mid-pass and renumber everything after it.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Camera, Check, Home, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithLocationSearch } from "~/app/_components/combobox/with-search-hook";
import { LocationScanButton } from "~/app/_components/locations/location-scan-button";
import { useLocationPhotoCapture } from "~/app/_components/locations/use-location-photo-capture";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Progress } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { PhotoPassStop } from "./PhotoPassStop";
import {
  advanceToOutstanding,
  flattenPhotoStops,
  isPassComplete,
  type PhotoStop,
} from "./photo-pass-utils";

export interface PhotoPassSearch {
  parent?: LocationShortcode;
  scope?: "house" | "scan";
  all?: boolean;
  type?: LocationType[];
}

const EMPTY_ROOTS: InfLocation[] = [];

export function PhotoPassWorkbench(search: PhotoPassSearch) {
  const { parent, scope } = search;

  if (scope === "scan") return <ScanPass />;
  if (parent || scope === "house") return <QueuePass {...search} />;
  return <PhotoPassStart />;
}

/* -------------------------------------------------------------------------- */

function PhotoPassStart() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<ComboboxItem<LocationShortcode> | null>(
    null,
  );

  const go = (next: PhotoPassSearch) =>
    void navigate({ to: "/locations/photo-pass", search: next });

  return (
    <Card>
      <CardContent className="px-4 py-4">
        <Stack gap="md">
          <Description>
            Take or retake photos of a run of locations. A new shot becomes the
            cover and the old photos are kept, and each one re-runs that
            location's AI description.
          </Description>

          <Stack gap="sm">
            <h2 className="my-0 font-heading font-semibold text-sm">
              Start from a location
            </h2>
            <Description>
              Walks everything inside it that has no photo yet.
            </Description>
            <WithLocationSearch>
              {({ items, onSearchChange, isLoading, onOpenChange }) => (
                <EntityPicker
                  entity="location"
                  label="location"
                  items={items}
                  value={picked}
                  setValue={(item) => {
                    setPicked(item);
                    if (item) go({ parent: item.id });
                  }}
                  onSearchChange={onSearchChange}
                  onOpenChange={onOpenChange}
                  isLoading={isLoading}
                  placeholder="Garage, pantry, shed…"
                />
              )}
            </WithLocationSearch>
          </Stack>

          <Row gap="sm" wrap>
            <LocationScanButton
              variant="outline"
              buttonLabel="Scan a location"
              sheetDescription="Photograph whatever you scan, one bin at a time."
              onResolved={(_id, shortcode) => {
                if (!shortcode) return false;
                go({ scope: "scan" });
                return true;
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-12 flex-1 px-4"
              onClick={() => go({ scope: "house" })}
            >
              <Home className="mr-2 size-4" />
              Everything missing a photo
            </Button>
          </Row>
        </Stack>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Scan-driven mode: the scanned location *is* the stop. No queue, no cursor —
 * scan, shoot, scan the next one.
 */
function ScanPass() {
  const api = useTRPC();
  const [shortcode, setShortcode] = useState<LocationShortcode | null>(null);
  const { capture, discardCapture, isCapturing } = useLocationPhotoCapture();

  const { data: location, isLoading } = useQuery(
    api.location.getByShortcode.queryOptions(
      { shortcode: shortcode ?? "LOC-2222" },
      { enabled: shortcode != null },
    ),
  );

  const stop = useMemo<PhotoStop | null>(() => {
    if (!location) return null;
    return (
      flattenPhotoStops([{ ...location, children: [] }], {
        includePhotographed: true,
      })[0] ?? null
    );
  }, [location]);

  const handleCapture = async (file: File) => {
    if (!stop) return;
    try {
      const imageId = await capture(stop.id, file);
      toast.success(`Photographed ${stop.name}`, {
        action: {
          label: "Retake",
          onClick: () => {
            void discardCapture(stop.id, imageId).catch((error: unknown) =>
              toast.error(`Retake failed: ${getErrorMessage(error)}`),
            );
          },
        },
      });
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    }
  };

  return (
    <Stack gap="md">
      <Card>
        <CardContent className="px-4 py-4">
          <Row gap="sm" wrap align="center" justify="between">
            <LocationScanButton
              buttonLabel={stop ? "Scan next location" : "Scan a location"}
              sheetDescription="Photograph whatever you scan, one bin at a time."
              onResolved={(_id, code) => {
                if (!code) {
                  toast.error("Scan a location QR, not a raw id.");
                  return false;
                }
                setShortcode(code);
                return true;
              }}
            />
            <Link
              to="/locations/photo-pass"
              search={{}}
              className="text-muted-foreground text-sm underline decoration-dotted underline-offset-2"
            >
              Change mode
            </Link>
          </Row>
        </CardContent>
      </Card>

      {isLoading && <Spinner />}

      {stop ? (
        <PhotoPassStop
          key={stop.id}
          stop={stop}
          position={1}
          total={1}
          isCapturing={isCapturing}
          onCapture={(file) => void handleCapture(file)}
          onSkip={() => setShortcode(null)}
        />
      ) : (
        !isLoading && (
          <Empty>
            <EmptyTitle>Nothing scanned yet</EmptyTitle>
            <EmptyDescription>
              Scan a location QR and its photo screen opens here.
            </EmptyDescription>
          </Empty>
        )
      )}
    </Stack>
  );
}

/* -------------------------------------------------------------------------- */

function QueuePass({ parent, all, type }: PhotoPassSearch) {
  const api = useTRPC();
  const navigate = useNavigate();
  const includePhotographed = all === true;
  const { capture, discardCapture, isCapturing } = useLocationPhotoCapture();

  const subtreeQuery = useQuery(
    api.location.subtree.queryOptions(
      { shortcode: parent ?? "LOC-2222" },
      { enabled: parent != null },
    ),
  );
  const treeQuery = useQuery({
    ...api.location.makeTree.queryOptions(),
    enabled: parent == null,
  });
  const roots = (parent ? subtreeQuery.data : treeQuery.data) ?? EMPTY_ROOTS;
  const isLoading = parent ? subtreeQuery.isLoading : treeQuery.isLoading;

  const [photographed, setPhotographed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [currentIndex, setCurrentIndex] = useState(0);

  // Every location in scope, keyed by id — the live content behind each stop.
  // Built unfiltered so a location that has just been photographed (and would
  // now fail the default filter) can still be looked up for the rest of the pass.
  const stopsById = useMemo(() => {
    const everyStop = flattenPhotoStops(roots, { includePhotographed: true });
    return new Map(everyStop.map((stop) => [stop.id, stop]));
  }, [roots]);

  const scopeKey = `${parent ?? "house"}|${includePhotographed}|${(type ?? []).join(",")}`;
  const candidateIds = useMemo(
    () =>
      flattenPhotoStops(roots, { includePhotographed, types: type }).map(
        (stop) => stop.id,
      ),
    [roots, includePhotographed, type],
  );

  // Freeze the queue's membership for the scope. Adjusting state during render
  // is the documented React pattern for this; the guard on `length > 0` keeps
  // an in-flight query from freezing an empty queue.
  const [frozenQueue, setFrozenQueue] = useState<{
    key: string;
    ids: LocationShortcode[];
  }>({ key: "", ids: [] });
  if (frozenQueue.key !== scopeKey && candidateIds.length > 0) {
    setFrozenQueue({ key: scopeKey, ids: candidateIds });
    setPhotographed(new Set());
    setSkipped(new Set());
    setCurrentIndex(0);
  }

  const stops = useMemo(
    () =>
      frozenQueue.ids.flatMap((id) => {
        const stop = stopsById.get(id);
        return stop ? [stop] : [];
      }),
    [frozenQueue, stopsById],
  );

  const settled = useMemo(
    () => new Set([...photographed, ...skipped]),
    [photographed, skipped],
  );
  const current = stops[currentIndex] ?? null;
  const complete = isPassComplete(stops, settled);

  const settle = (stopId: string, markPhotographed: boolean) => {
    const next = new Set([...settled, stopId]);
    if (markPhotographed) {
      setPhotographed((prev) => new Set(prev).add(stopId));
    } else {
      setSkipped((prev) => new Set(prev).add(stopId));
    }
    setCurrentIndex(advanceToOutstanding(stops, currentIndex, next));
  };

  const handleRetake = async (
    stop: PhotoStop,
    imageId: string,
    index: number,
  ) => {
    try {
      await discardCapture(stop.id, imageId);
      setPhotographed((prev) => {
        const next = new Set(prev);
        next.delete(stop.id);
        return next;
      });
      setCurrentIndex(index);
    } catch (error) {
      toast.error(`Retake failed: ${getErrorMessage(error)}`);
    }
  };

  const handleCapture = async (stop: PhotoStop, file: File) => {
    const index = currentIndex;
    try {
      const imageId = await capture(stop.id, file);
      settle(stop.id, true);
      toast.success(`Photographed ${stop.name}`, {
        action: {
          label: "Retake",
          onClick: () => void handleRetake(stop, imageId, index),
        },
      });
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    }
  };

  if (isLoading) {
    return (
      <Row justify="center" className="py-12">
        <Spinner />
      </Row>
    );
  }

  if (stops.length === 0) {
    return (
      <Empty>
        <EmptyTitle>
          {includePhotographed
            ? "Nothing in scope"
            : "Everything here has a photo"}
        </EmptyTitle>
        <EmptyDescription>
          {includePhotographed
            ? "No locations match this scope and type filter."
            : "Switch to retake mode to photograph these again."}
        </EmptyDescription>
        <Row gap="sm" className="mt-4">
          {!includePhotographed && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/locations/photo-pass",
                  search: {
                    parent,
                    scope: parent ? undefined : "house",
                    all: true,
                  },
                })
              }
            >
              <RotateCcw className="mr-2 size-4" />
              Include photographed
            </Button>
          )}
          <Link
            to="/locations/photo-pass"
            search={{}}
            className="text-muted-foreground text-sm underline decoration-dotted underline-offset-2"
          >
            Change scope
          </Link>
        </Row>
      </Empty>
    );
  }

  return (
    <Stack gap="md">
      <Card>
        <CardContent className="px-4 py-2">
          <Stack gap="xs">
            <Row align="center" justify="between" gap="sm">
              <Description>
                {photographed.size} photographed
                {skipped.size > 0 && `, ${skipped.size} skipped`} of{" "}
                {stops.length}
              </Description>
              <Link
                to="/locations/photo-pass"
                search={{}}
                className="shrink-0 text-muted-foreground text-sm underline decoration-dotted underline-offset-2"
              >
                Change scope
              </Link>
            </Row>
            <Progress value={(settled.size / stops.length) * 100} />
          </Stack>
        </CardContent>
      </Card>

      {complete || !current ? (
        <Empty>
          <Check className="size-8 text-muted-foreground" />
          <EmptyTitle>Pass complete</EmptyTitle>
          <EmptyDescription>
            {photographed.size} photographed
            {skipped.size > 0 && `, ${skipped.size} skipped`}. AI descriptions
            refresh in the background.
          </EmptyDescription>
          <Row gap="sm" className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSkipped(new Set());
                setCurrentIndex(
                  advanceToOutstanding(stops, -1, new Set(photographed)),
                );
              }}
              disabled={skipped.size === 0}
            >
              <Camera className="mr-2 size-4" />
              Revisit skipped
            </Button>
            <Link
              to="/locations/photo-pass"
              search={{}}
              className="text-muted-foreground text-sm underline decoration-dotted underline-offset-2"
            >
              Start another pass
            </Link>
          </Row>
        </Empty>
      ) : (
        <PhotoPassStop
          key={current.id}
          stop={current}
          position={settled.size + 1}
          total={stops.length}
          isCapturing={isCapturing}
          onCapture={(file) => void handleCapture(current, file)}
          onSkip={() => settle(current.id, false)}
        />
      )}
    </Stack>
  );
}
