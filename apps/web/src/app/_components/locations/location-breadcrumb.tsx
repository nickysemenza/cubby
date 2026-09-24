import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { SquaresFourIcon as LayoutDashboard } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Description } from "~/components/ui/description";
import { getDefaultLocationType } from "~/lib/location-path";
import { cn } from "~/lib/utils";

import { LocationIcon } from "./location-icons";

export interface LocationSegment {
  id?: string;
  name: string;
  type: LocationType | null;
}

/**
 * Convert an InfLocation (with parent chain) to an array of LocationSegments.
 * Returns segments from root to leaf.
 *
 * Exported because the same walk is how a picker row derives its breadcrumb for
 * a location fetched by shortcode — that read carries a nested `parent` chain
 * rather than the flat `ancestors` the search endpoint returns.
 */
export function locationToSegments(location: InfLocation): LocationSegment[] {
  const segments: LocationSegment[] = [];

  // Walk up the parent chain
  let current: InfLocation | null | undefined = location;
  while (current) {
    segments.unshift({
      id: current.id,
      name: current.name,
      type: current.type,
    });
    current = current.parent;
  }

  return segments;
}

interface LocationBreadcrumbProps {
  /** Array of location segments from root to leaf (alternative to location prop) */
  segments?: LocationSegment[];
  /** Location object to derive segments from (alternative to segments prop) */
  location?: InfLocation;
  /** Show [type] annotation for non-default types */
  showTypeAnnotations?: boolean;
  /** Highlight segments with non-default types */
  highlightNonDefault?: boolean;
  /** Make segments clickable links to /locations/{id} */
  linkable?: boolean;
  /** Callback when segment is clicked (alternative to linkable) */
  onSegmentClick?: (locationId: string) => void;
  /** Show the application dashboard link before the location segments */
  showHome?: boolean;
  /** Truncate long segment names */
  compact?: boolean;
  /** Add bg-primary/10 tint to active (last) segment */
  activeHighlight?: boolean;
  /** Additional class name */
  className?: string;
}

/**
 * Unified location breadcrumb component.
 * Can be used for navigation (with links) or display (showing type annotations).
 * Accepts either segments array or a location object.
 */
export function LocationBreadcrumb({
  segments: segmentsProp,
  location,
  showTypeAnnotations = false,
  highlightNonDefault = false,
  linkable = false,
  onSegmentClick,
  showHome = false,
  compact = false,
  activeHighlight = false,
  className,
}: LocationBreadcrumbProps) {
  // Derive segments from location if not provided directly
  const segments =
    segmentsProp ?? (location ? locationToSegments(location) : []);
  if (segments.length === 0 && !showHome) return null;

  return (
    <Breadcrumb className={cn("overflow-x-auto", className)}>
      <BreadcrumbList className="flex-nowrap">
        {showHome && (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink
                render={
                  <Link
                    to="/"
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted" /* tight: breadcrumb icon+label */
                  />
                }
              >
                <LayoutDashboard size={14} />
                <span>Dashboard</span>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {segments.length > 0 && <BreadcrumbSeparator />}
          </>
        )}
        {segments.map((segment, index) => {
          const isDefault = segment.type === getDefaultLocationType(index);
          const isLast = index === segments.length - 1;

          const content = (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                isLast && "font-medium",
                highlightNonDefault &&
                  !isDefault &&
                  "rounded border border-warning/50 bg-warning/10 px-1 py-px",
                isLast && activeHighlight && "rounded bg-primary/10 px-1 py-px",
              )}
            >
              <LocationIcon
                type={segment.type}
                product={null}
                size={12}
                colored
              />
              <span className={cn("min-w-0", compact && "max-w-32 truncate")}>
                {segment.name}
              </span>
              {showTypeAnnotations && !isDefault && segment.type && (
                <Description as="span" size="2xs">
                  · {segment.type}
                </Description>
              )}
            </span>
          );

          return (
            <React.Fragment key={segment.id ?? index}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {onSegmentClick && segment.id && !isLast ? (
                  <button
                    type="button"
                    onClick={() => onSegmentClick(segment.id!)}
                    className="inline-flex min-h-11 items-center transition-opacity hover:opacity-80"
                  >
                    {content}
                  </button>
                ) : linkable && segment.id && !isLast ? (
                  <BreadcrumbLink
                    render={
                      <Link
                        to="/locations/$shortcode"
                        params={{ shortcode: segment.id }}
                        className="inline-flex min-h-11 items-center"
                      />
                    }
                  >
                    {content}
                  </BreadcrumbLink>
                ) : isLast ? (
                  <BreadcrumbPage>{content}</BreadcrumbPage>
                ) : (
                  content
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
