"use client";

import { type InfLocation } from "~/schemas/location";
import { LocationBreadcrumb, locationToSegments } from "./location-breadcrumb";

interface EnhancedBreadcrumbsProps {
  location: InfLocation;
  className?: string;
}

/**
 * Location breadcrumb navigation with links and home button.
 * Wrapper around LocationBreadcrumb for backwards compatibility.
 */
export function EnhancedBreadcrumbs({
  location,
  className,
}: EnhancedBreadcrumbsProps) {
  const segments = locationToSegments(location);

  return (
    <LocationBreadcrumb
      segments={segments}
      linkable
      showHome
      className={className}
    />
  );
}
