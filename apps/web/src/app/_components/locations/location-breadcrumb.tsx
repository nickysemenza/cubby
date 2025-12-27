"use client";

import * as React from "react";
import Link from "next/link";
import { Home } from "lucide-react";
import { LocationIcon } from "./location-icons";
import type { LocationType, InfLocation } from "~/schemas/location";
import { cn } from "~/lib/utils";
import { getDefaultLocationType } from "~/lib/location-path";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";

interface LocationSegment {
  id?: string;
  name: string;
  type: LocationType;
}

/**
 * Convert an InfLocation (with parent chain) to an array of LocationSegments.
 * Returns segments from root to leaf.
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
  /** Show a Home link before the location segments */
  showHome?: boolean;
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
  showHome = false,
  className,
}: LocationBreadcrumbProps) {
  // Derive segments from location if not provided directly
  const segments =
    segmentsProp ?? (location ? locationToSegments(location) : []);
  if (segments.length === 0 && !showHome) return null;

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {showHome && (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink
                render={
                  <Link
                    href="/"
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted"
                  />
                }
              >
                <Home size={14} />
                <span>Home</span>
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
                "flex items-center gap-1.5 rounded-md px-2 py-1",
                highlightNonDefault && !isDefault
                  ? "border-2 border-amber-500/50 bg-amber-50 dark:bg-amber-950/30"
                  : "bg-muted/50",
                isLast && "font-medium",
              )}
            >
              <LocationIcon type={segment.type} size={14} />
              <span>{segment.name}</span>
              {showTypeAnnotations && !isDefault && (
                <span className="text-muted-foreground text-xs">
                  [{segment.type}]
                </span>
              )}
            </span>
          );

          return (
            <React.Fragment key={segment.id ?? index}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {linkable && segment.id && !isLast ? (
                  <BreadcrumbLink
                    render={<Link href={`/locations/${segment.id}`} />}
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
