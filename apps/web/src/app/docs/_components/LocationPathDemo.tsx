"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { LocationBreadcrumb } from "~/app/_components/locations/location-breadcrumb";
import { type LocationType, locationType } from "~/schemas/location";
import {
  buildLocationPath,
  getDefaultLocationType,
  parseLocationPathWithTypes,
} from "~/lib/location-path";
import { cn } from "~/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Plus, Trash2 } from "lucide-react";

interface LocationSegment {
  name: string;
  type: LocationType;
}

// All valid location types
const locationTypes = locationType.options;

export function LocationPathDemo() {
  const [segments, setSegments] = useState<LocationSegment[]>([
    { name: "Garage", type: "room" },
    { name: "Chrome Shelf", type: "shelf" },
    { name: "Tool Bin", type: "crate" },
  ]);

  // Build the location data structure for buildLocationPath
  // Constructs a linked list from root to leaf
  type LocationNode = {
    name: string;
    type: string;
    parent: LocationNode | null;
  };

  const buildLocationData = (segs: LocationSegment[]): LocationNode | null => {
    if (segs.length === 0) return null;

    let result: LocationNode | null = null;

    for (const seg of segs) {
      result = { name: seg.name, type: seg.type, parent: result };
    }

    return result;
  };

  const locationData = buildLocationData(segments);
  const pathString = locationData ? buildLocationPath(locationData) : "";

  // Parse back to verify round-trip
  const parsed = pathString ? parseLocationPathWithTypes(pathString) : [];

  const updateSegment = (
    index: number,
    field: "name" | "type",
    value: string,
  ) => {
    setSegments((prev) =>
      prev.map((seg, i) =>
        i === index
          ? {
              ...seg,
              [field]: field === "type" ? (value as LocationType) : value,
            }
          : seg,
      ),
    );
  };

  const addSegment = () => {
    const newType = getDefaultLocationType(segments.length);
    setSegments((prev) => [...prev, { name: "New Location", type: newType }]);
  };

  const removeSegment = (index: number) => {
    setSegments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-6">
      {/* Editor */}
      <div className="space-y-3">
        <div className="text-muted-foreground text-sm font-medium">
          Location Hierarchy
        </div>
        {segments.map((seg, index) => (
          <div key={index} className="flex items-center gap-2">
            {index > 0 && (
              <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
            )}
            <div className="flex flex-1 items-center gap-2">
              <Input
                value={seg.name}
                onChange={(e) => updateSegment(index, "name", e.target.value)}
                className="flex-1"
                placeholder="Location name"
              />
              <Select
                value={seg.type}
                onValueChange={(value) => updateSegment(index, "type", value)}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locationTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      <div className="flex items-center gap-2">
                        <LocationIcon type={type} size={14} />
                        <span>{type}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div
                className={cn(
                  "text-muted-foreground w-20 text-xs",
                  seg.type === getDefaultLocationType(index)
                    ? "text-green-600 dark:text-green-400"
                    : "text-amber-600 dark:text-amber-400",
                )}
              >
                {seg.type === getDefaultLocationType(index) ? (
                  "default"
                ) : (
                  <>
                    non-default
                    <br />
                    (needs [])
                  </>
                )}
              </div>
              {segments.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeSegment(index)}
                  className="h-8 w-8"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addSegment}>
          <Plus className="mr-1 h-4 w-4" />
          Add Level
        </Button>
      </div>

      {/* Visual Breadcrumb */}
      <div className="space-y-2">
        <div className="text-muted-foreground text-sm font-medium">
          Visual Preview
        </div>
        <div className="rounded-lg border p-3">
          <LocationBreadcrumb
            segments={segments}
            showTypeAnnotations
            highlightNonDefault
          />
        </div>
      </div>

      {/* CSV Path Output */}
      <div className="space-y-2">
        <div className="text-muted-foreground text-sm font-medium">
          CSV Path Format
        </div>
        <div className="bg-muted rounded-lg border p-3 font-mono text-sm">
          {pathString || <span className="text-muted-foreground">Empty</span>}
        </div>
        <p className="text-muted-foreground text-xs">
          Brackets only appear for non-default types. Default: root =
          &quot;room&quot;, children = &quot;shelf&quot;
        </p>
      </div>

      {/* Parse verification */}
      <div className="space-y-2">
        <div className="text-muted-foreground text-sm font-medium">
          Parsed Back (verification)
        </div>
        <div className="bg-muted rounded-lg border p-3 font-mono text-xs">
          {parsed.map((p, i) => (
            <span key={i}>
              {i > 0 && " → "}
              {p.name}
              <span className="text-muted-foreground">[{p.type}]</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
