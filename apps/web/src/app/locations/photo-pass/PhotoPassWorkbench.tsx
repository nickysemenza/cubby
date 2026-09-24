import type {
  ImageShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";
/**
 * Walk a queue of locations taking one photo each.
 *
 * Three ways in, all landing on the same stop screen:
 *  - **scoped** — every descendant of a chosen parent (`location.subtree`)
 *  - **house** — the whole forest's missing-photo backlog (`location.makeTree`)
 *  - **scan** — no queue; a QR scan names the stop, then the scanner reopens
 *
 * Nothing is staged — every photo commits the moment it is taken, so the source
 * of truth is the data itself. The pass position is still worth keeping: walking
 * a house is long enough that a backgrounded phone or a stray reload used to
 * cost the whole walk, so `useQueuePass` persists the cursor per scope and
 * offers resume-or-restart on the way back in.
 *
 * Queue *membership* is frozen per scope while its *contents* stay live —
 * without the freeze, photographing a location would drop it from the default
 * filter mid-pass and renumber everything after it. That rule, the settle
 * bookkeeping, and the advance cursor all live in `_components/queue-pass`,
 * shared with the recount session and the ingredient review queue.
 */
import type { InfLocation } from "@cubby/schemas/location";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CameraIcon } from "@phosphor-icons/react/dist/csr/Camera";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { LocationScanButton } from "~/app/_components/locations/location-scan-button";
import { useLocationPhotoCapture } from "~/app/_components/locations/use-location-photo-capture";
import {
  QueuePassProgress,
  QueuePassResumePrompt,
} from "~/app/_components/queue-pass/QueuePassProgress";
import {
  type QueuePassPersistence,
  useQueuePass,
} from "~/app/_components/queue-pass/useQueuePass";
import { location } from "~/app/locations/location.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { getErrorMessage } from "~/lib/error-utils";

import type { PhotoPassSearch } from "./photo-pass-search";
import { flattenPhotoStops, type PhotoStop } from "./photo-pass-utils";
import { PhotoPassStop } from "./PhotoPassStop";

const EMPTY_ROOTS: InfLocation[] = [];

/**
 * Scope-keyed resume storage. The key carries the parent, the retake flag and
 * the type filter, so switching scope starts a fresh pass rather than resuming
 * a different queue's cursor into it.
 */
const PHOTO_PASS_PERSISTENCE: QueuePassPersistence<undefined> = {
  storageKey: (scopeKey) => `cubby:photo-pass:${scopeKey}`,
  version: 1,
  extraSchema: z.undefined(),
};

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
            <h2 className="my-0 font-heading text-sm font-semibold">
              Start from a location
            </h2>
            <Description>
              Walks everything inside it that has no photo yet.
            </Description>
            <WithEntitySearch entity="location">
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
            </WithEntitySearch>
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
              <HouseIcon className="mr-2 size-4" />
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
  const [shortcode, setShortcode] = useState<LocationShortcode | null>(null);
  const { capture, discardCapture, isCapturing } = useLocationPhotoCapture();

  const scanQuery = useQuery(
    entityDetailFor("location").queryOptions(shortcode ?? "LOC-2222", {
      enabled: shortcode != null,
    }),
  );
  const { data: location, isLoading } = scanQuery;

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
            void discardCapture(stop.id, imageId).catch((error) =>
              showErrorToast(error, "Retake failed"),
            );
          },
        },
      });
    } catch (error) {
      showErrorToast(error, "Photo failed");
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
              className="inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground underline decoration-dotted underline-offset-2 md:min-h-8 md:px-0"
            >
              Change mode
            </Link>
          </Row>
        </CardContent>
      </Card>

      {isLoading && <Spinner />}

      {scanQuery.isError ? (
        <PhotoPassLoadError
          title="Couldn't load this scanned location"
          detail={getErrorMessage(scanQuery.error)}
          onRetry={() => void scanQuery.refetch()}
        />
      ) : stop ? (
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
  const navigate = useNavigate();
  const includePhotographed = all === true;
  const { capture, discardCapture, isCapturing } = useLocationPhotoCapture();

  const subtreeQuery = useQuery({
    ...location.subtree.queryOptions({
      shortcode: parent ?? "LOC-2222",
    }),
    enabled: parent != null,
  });
  const treeQuery = useQuery({
    ...location.makeTree.queryOptions(),
    enabled: parent == null,
  });
  const activeQuery = parent ? subtreeQuery : treeQuery;
  const roots = activeQuery.data ?? EMPTY_ROOTS;
  const isLoading = activeQuery.isLoading;

  // Every location in scope, keyed by id — the live content behind each stop.
  // Built unfiltered so a location that has just been photographed (and would
  // now fail the default filter) can still be looked up for the rest of the pass.
  const stopsById = useMemo(() => {
    const everyStop = flattenPhotoStops(roots, { includePhotographed: true });
    return new Map<string, PhotoStop>(everyStop.map((stop) => [stop.id, stop]));
  }, [roots]);

  const scopeKey = `${parent ?? "house"}|${includePhotographed}|${(type ?? []).join(",")}`;
  const candidateIds = useMemo(
    () =>
      flattenPhotoStops(roots, { includePhotographed, types: type }).map(
        (stop) => stop.id,
      ),
    [roots, includePhotographed, type],
  );

  const pass = useQueuePass<PhotoStop>({
    scopeKey,
    candidateIds,
    stopsById,
    persistence: PHOTO_PASS_PERSISTENCE,
  });
  const { stops, current, counts, complete } = pass;

  const handleRetake = async (stop: PhotoStop, imageId: ImageShortcode) => {
    try {
      await discardCapture(stop.id, imageId);
      pass.unsettle(stop.id);
    } catch (error) {
      showErrorToast(error, "Retake failed");
    }
  };

  const handleCapture = async (stop: PhotoStop, file: File) => {
    try {
      const imageId = await capture(stop.id, file);
      pass.settle(stop.id, "completed");
      toast.success(`Photographed ${stop.name}`, {
        action: {
          label: "Retake",
          onClick: () => void handleRetake(stop, imageId),
        },
      });
    } catch (error) {
      showErrorToast(error, "Photo failed");
    }
  };

  if (isLoading) {
    return (
      <Row justify="center" className="py-12">
        <Spinner />
      </Row>
    );
  }

  // An empty queue is a success state. Keep a failed scope query distinct so
  // a transient outage cannot present a completed or empty photo pass.
  if (activeQuery.isError) {
    return (
      <PhotoPassLoadError
        title="Couldn't load this photo pass"
        detail={getErrorMessage(activeQuery.error)}
        onRetry={() => void activeQuery.refetch()}
      />
    );
  }

  if (pass.resumeCandidate) {
    return (
      <QueuePassResumePrompt
        candidate={pass.resumeCandidate}
        title="Resume this photo pass?"
        itemNoun="locations"
        onResume={() => pass.resumePass()}
        onStartNew={pass.startNewPass}
      />
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
              <ArrowCounterClockwiseIcon className="mr-2 size-4" />
              Include photographed
            </Button>
          )}
          <Link
            to="/locations/photo-pass"
            search={{}}
            className="inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground underline decoration-dotted underline-offset-2 md:min-h-8 md:px-0"
          >
            Change scope
          </Link>
        </Row>
      </Empty>
    );
  }

  return (
    <Stack gap="md">
      <QueuePassProgress
        counts={counts}
        noun="photographed"
        trailing={
          <Link
            to="/locations/photo-pass"
            search={{}}
            className="inline-flex min-h-11 shrink-0 items-center px-2 text-sm text-muted-foreground underline decoration-dotted underline-offset-2 md:min-h-8 md:px-0"
          >
            Change scope
          </Link>
        }
      />

      {complete || !current ? (
        <Empty>
          <CheckIcon className="size-8 text-muted-foreground" />
          <EmptyTitle>Pass complete</EmptyTitle>
          <EmptyDescription>
            {counts.completed} photographed
            {counts.skipped > 0 && `, ${counts.skipped} skipped`}. AI
            descriptions refresh in the background.
          </EmptyDescription>
          <Row gap="sm" className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={pass.revisitSkipped}
              disabled={counts.skipped === 0}
            >
              <CameraIcon className="mr-2 size-4" />
              Revisit skipped
            </Button>
            <Link
              to="/locations/photo-pass"
              search={{}}
              className="inline-flex min-h-11 items-center px-2 text-sm text-muted-foreground underline decoration-dotted underline-offset-2 md:min-h-8 md:px-0"
            >
              Start another pass
            </Link>
          </Row>
        </Empty>
      ) : (
        <PhotoPassStop
          key={current.id}
          stop={current}
          position={counts.settled + 1}
          total={counts.total}
          isCapturing={isCapturing}
          onCapture={(file) => void handleCapture(current, file)}
          onSkip={() => pass.settle(current.id, "skipped")}
        />
      )}
    </Stack>
  );
}

export function PhotoPassLoadError({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Empty role="alert">
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{detail}</EmptyDescription>
      <EmptyActions>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 md:min-h-10"
          onClick={onRetry}
        >
          Retry
        </Button>
      </EmptyActions>
    </Empty>
  );
}
