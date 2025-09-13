"use client";
import Link from "next/link";
import { Home } from "lucide-react";
import {
  BreadcrumbSeparator,
  BreadcrumbItem,
  BreadcrumbLink,
  Breadcrumb,
  BreadcrumbList,
} from "~/components/ui/breadcrumb";
import { type InfLocation, collectInfiniteParents } from "~/schemas/location";
import { LocationIcon } from "./location-icons";

interface EnhancedBreadcrumbsProps {
  location: InfLocation;
  className?: string;
}

export function EnhancedBreadcrumbs({
  location,
  className,
}: EnhancedBreadcrumbsProps) {
  const parentHierarchy = collectInfiniteParents(location);

  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {/* Home Link */}
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/" className="flex items-center gap-1">
              <Home size={14} />
              <span>Home</span>
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {/* Parent Hierarchy */}
        {parentHierarchy.reverse().map((parentLocation) => (
          <div key={parentLocation.id} className="flex items-center">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link
                  href={`/locations/${parentLocation.id}`}
                  className="flex items-center gap-1"
                >
                  <LocationIcon type={parentLocation.type} size={14} />
                  <span>{parentLocation.name}</span>
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </div>
        ))}

        {/* Current Location */}
        <BreadcrumbSeparator />
        <BreadcrumbItem className="text-foreground font-medium">
          <LocationIcon type={location.type} size={14} />
          <span>{location.name}</span>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
