import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { ChevronRight, Search } from "lucide-react";
import pluralize from "pluralize";
import { useEffect, useMemo, useState } from "react";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import {
  flattenAllLocations,
  flattenAuditableLocations,
  flattenPickerTree,
  formatChildCount,
  getSessionRootCandidates,
  locationTypeNoun,
} from "../session-utils";
import { LocationScanButton } from "./QrJumpButton";

export function ParentPicker({
  locations,
  initialParentId,
  onSelect,
}: {
  locations: InfLocation[];
  initialParentId?: LocationId;
  onSelect: (locationId: LocationId) => void;
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

  useEffect(() => {
    setExpandedIds(defaultExpandedIds);
  }, [defaultExpandedIds]);

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
      {initialParentId && (
        <Card>
          <CardContent className="p-4">
            <Description>
              That parent location could not be found. Choose a location to
              start a session.
            </Description>
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
                onResolved={(locationId) => {
                  onSelect(locationId);
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
            </Row>
          </Stack>
          {showAreas && (
            <div className="relative pt-2">
              <Search className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
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
                // biome-ignore lint/a11y/useSemanticElements: This row contains a separate expand button, so it cannot be a native button.
                <div
                  key={location.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(location.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(location.id);
                    }
                  }}
                  className="w-full border-[var(--border)] border-b bg-card py-2 pr-3 text-left transition-colors last:border-b-0 hover:bg-muted" /* tight: compact tree picker row */
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
                        <ChevronRight className="size-4" />
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
