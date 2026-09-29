import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import pluralize from "pluralize";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { LocationScanButton } from "~/app/_components/locations/location-scan-button";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { formatRelative } from "~/lib/date-format";
import { cn } from "~/lib/utils";

import {
  RECOUNT_WORKLISTS,
  type RecountWorklist,
  WORKLIST_TITLES,
  worklistScopeKey,
} from "../../worklist/worklist-locations";
import {
  flattenAllLocations,
  flattenAuditableLocations,
  flattenPickerTree,
  formatChildCount,
  getSessionRootCandidates,
  locationTypeNoun,
} from "../session-utils";
import {
  clearStoredSessionPass,
  listStoredSessionPasses,
  type StoredSessionPass,
} from "../useSessionProgress";

const NO_STORED_PASSES: StoredSessionPass[] = [];

const worklistForRootId = (rootId: string) =>
  RECOUNT_WORKLISTS.find((worklist) => worklistScopeKey(worklist) === rootId) ??
  null;

export function ParentPicker({
  locations,
  initialParentShortcode,
  onSelect,
  onSelectWorklist,
}: {
  locations: InfLocation[];
  initialParentShortcode?: LocationShortcode;
  onSelect: (shortcode: LocationShortcode) => void;
  onSelectWorklist: (worklist: RecountWorklist) => void;
}) {
  const candidateIds = useMemo(
    () =>
      new Set(
        getSessionRootCandidates(flattenAllLocations(locations)).map(
          (location) => location.id,
        ),
      ),
    [locations],
  );
  const defaultExpandedIds = useMemo(
    () =>
      new Set(
        locations
          .filter((location) => candidateIds.has(location.id))
          .map((location) => location.id),
      ),
    [candidateIds, locations],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => defaultExpandedIds,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [showAreas, setShowAreas] = useState(false);
  // Read after mount only: localStorage is client-only, and starting empty keeps
  // the SSR markup and the first client render identical.
  const [storedPasses, setStoredPasses] =
    useState<StoredSessionPass[]>(NO_STORED_PASSES);

  useEffect(() => {
    setExpandedIds(defaultExpandedIds);
  }, [defaultExpandedIds]);

  // Keyed by plain string: stored root ids come from localStorage, not a
  // branded source, and only ever get read back out as a resolved location.
  const locationsById = useMemo(
    () =>
      new Map<string, InfLocation>(
        flattenAllLocations(locations).map((loc) => [loc.id, loc]),
      ),
    [locations],
  );

  useEffect(() => {
    if (locationsById.size === 0) return;
    // A stored root that no longer exists (deleted or renamed away) can never be
    // resumed, so drop its key rather than showing a dead card.
    setStoredPasses(
      listStoredSessionPasses().filter((pass) => {
        // A worklist pass is keyed by the worklist, not a location, so it has
        // no root to go missing.
        if (worklistForRootId(pass.rootId)) return true;
        if (locationsById.has(pass.rootId)) return true;
        clearStoredSessionPass(pass.rootId);
        return false;
      }),
    );
  }, [locationsById]);

  const inProgressPasses = useMemo(
    () =>
      storedPasses.flatMap((pass) => {
        const worklist = worklistForRootId(pass.rootId);
        if (worklist) {
          // The worklist's live size is a product-set read the picker does not
          // make, so the persisted total is the only one available here.
          const total = pass.totalCount ?? 0;
          const settled = pass.completedCount + pass.skippedCount;
          if (total === 0 || settled >= total) return [];
          return [
            {
              ...pass,
              name: WORKLIST_TITLES[worklist],
              resume: () => onSelectWorklist(worklist),
              settled,
              total,
            },
          ];
        }
        const location = locationsById.get(pass.rootId);
        if (!location) return [];
        // The live tree is authoritative for the total; the persisted count is
        // only a fallback for entries written before it was stored.
        const total =
          flattenAuditableLocations(location).length || (pass.totalCount ?? 0);
        const settled = pass.completedCount + pass.skippedCount;
        if (total === 0 || settled >= total) return [];
        return [
          {
            ...pass,
            name: location.name,
            resume: () => onSelect(location.id),
            settled,
            total,
          },
        ];
      }),
    [locationsById, onSelect, onSelectWorklist, storedPasses],
  );

  const dismissPass = (rootId: string) => {
    clearStoredSessionPass(rootId);
    setStoredPasses((previous) =>
      previous.filter((pass) => pass.rootId !== rootId),
    );
  };

  const candidates = flattenPickerTree(locations, candidateIds, {
    expandedIds,
    searchTerm,
  });
  const searching = searchTerm.trim().length > 0;

  const toggleExpanded = (locationId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(locationId)) {
        next.delete(locationId);
      } else {
        next.add(locationId);
      }
      return next;
    });
  };

  return (
    <Stack gap="md" className="min-w-0">
      {initialParentShortcode && (
        <Card>
          <CardContent className="p-4">
            <Description>
              That parent location could not be found. Choose a location to
              start a session.
            </Description>
          </CardContent>
        </Card>
      )}
      {inProgressPasses.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="border-b p-4">
            <CardTitle>In progress</CardTitle>
            <Description>Unfinished recounts saved on this device.</Description>
          </CardHeader>
          <CardContent className="p-0">
            {inProgressPasses.map((pass) => (
              <Row
                key={pass.rootId}
                align="center"
                gap="sm"
                className="border-b border-[var(--border)] p-4 last:border-b-0"
              >
                <Stack gap="xs" className="min-w-0 flex-1">
                  <Row align="center" gap="sm" className="min-w-0">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {pass.name}
                    </span>
                    <Badge variant="outline">
                      {pass.settled}/{pass.total}
                    </Badge>
                    {pass.skippedCount > 0 && (
                      <Badge variant="slate">{pass.skippedCount} skipped</Badge>
                    )}
                  </Row>
                  <Description size="xs">
                    Started {formatRelative(pass.startedAt)} · updated{" "}
                    {formatRelative(pass.updatedAt)}
                  </Description>
                </Stack>
                <Button
                  type="button"
                  className="min-h-12 shrink-0"
                  onClick={pass.resume}
                >
                  Resume
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-12 shrink-0 px-2"
                  aria-label={`Dismiss saved ${pass.name} recount`}
                  onClick={() => dismissPass(pass.rootId)}
                >
                  <XIcon />
                </Button>
              </Row>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader className={cn("p-4", showAreas && "border-b")}>
          <Stack gap="sm">
            <div>
              <CardTitle>Start a recount</CardTitle>
              <Description>Scan the location in front of you.</Description>
            </div>
            <Row gap="sm" wrap>
              <LocationScanButton
                buttonLabel="Scan a location"
                sheetDescription="Start a recount at the scanned location."
                onResolved={(locationId, shortcode) => {
                  const resolved =
                    shortcode ?? locationsById.get(locationId)?.id;
                  if (!resolved) {
                    toast.error("Could not resolve that location's shortcode.");
                    return undefined;
                  }
                  onSelect(resolved);
                  return undefined;
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => setShowAreas((value) => !value)}
              >
                {showAreas ? "Hide areas" : "Choose an area"}
              </Button>
              {RECOUNT_WORKLISTS.map((worklist) => (
                <Button
                  key={worklist}
                  type="button"
                  variant="outline"
                  className="min-h-12"
                  onClick={() => onSelectWorklist(worklist)}
                >
                  Recount: {WORKLIST_TITLES[worklist]}
                </Button>
              ))}
            </Row>
          </Stack>
          {showAreas && (
            <div className="relative pt-2">
              <MagnifyingGlassIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search locations..."
                className="pl-6"
              />
            </div>
          )}
        </CardHeader>
        {showAreas && (
          <CardContent className="p-0">
            {candidates.length === 0 ? (
              <Description className="p-4">
                No matching session roots.
              </Description>
            ) : null}
            {candidates.map(({ location, depth, hasCandidateChildren }) => {
              const sessionCount = flattenAuditableLocations(location).length;
              const expanded = expandedIds.has(location.id) || searching;
              return (
                <div
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- This composite tree row contains a separate disclosure button, so a native button would create invalid nested controls.
                  role="button"
                  key={location.id}
                  tabIndex={0}
                  onClick={() => onSelect(location.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(location.id);
                    }
                  }}
                  className="w-full border-b border-[var(--border)] bg-card py-2 pr-3 text-left transition-colors last:border-b-0 hover:bg-muted" /* tight: compact tree picker row */
                >
                  <LocationTreeRow
                    location={location}
                    depth={depth}
                    compact
                    primaryMeta={locationTypeNoun(location.type)}
                    secondaryMeta={`${pluralize("location", sessionCount, true)} in session · ${pluralize("tracked item", location.totalItemCount ?? 0, true)}`}
                    leading={
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(location.id);
                        }}
                        className={cn(
                          "flex size-5 items-center justify-center transition-transform",
                          !hasCandidateChildren && "invisible",
                          expanded && "rotate-90",
                        )}
                        aria-label={
                          expanded
                            ? `Collapse ${location.name}`
                            : `Expand ${location.name}`
                        }
                        disabled={!hasCandidateChildren || searching}
                      >
                        <CaretRightIcon className="size-4" />
                      </button>
                    }
                    trailing={
                      <Badge variant="outline">
                        {formatChildCount(location.children?.length ?? 0)}
                      </Badge>
                    }
                  />
                </div>
              );
            })}
          </CardContent>
        )}
      </Card>
    </Stack>
  );
}
