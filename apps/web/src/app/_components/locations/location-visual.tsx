import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";
import { LocationIcon } from "./location-icons";
import {
  locationChildGroupLabel,
  resolveLocationVisual,
} from "./location-visual-resolver";

type LocationVisualVariant = "hero" | "card" | "compact";

interface LocationVisualProps {
  location: InfLocation;
  variant: LocationVisualVariant;
  className?: string;
  /** Compact rendered width; ignored by card/hero variants. */
  size?: number;
  /** Hero media can link each source; cards/rows already own their outer link. */
  interactive?: boolean;
}

function VisualFallback({ location }: { location: InfLocation }) {
  return (
    <LocationIcon
      type={location.type}
      product={location.product}
      size={20}
      className="text-muted-foreground"
    />
  );
}

function SourceLink({
  location,
  children,
}: {
  location: InfLocation;
  children: ReactNode;
}) {
  const visual = resolveLocationVisual(location);
  if (visual.primarySource === "product" && location.product) {
    return (
      <Link
        to="/products/$shortcode"
        params={{ shortcode: location.product.id }}
        aria-label={`Open product ${location.product.name}`}
        className="block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {children}
      </Link>
    );
  }
  if (visual.primarySource === "location" && visual.primaryImage) {
    return (
      <Link
        to="/images/$shortcode"
        params={{ shortcode: visual.primaryImage.id }}
        aria-label={`Open photo of ${location.name}`}
        className="block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {children}
      </Link>
    );
  }
  return <>{children}</>;
}

function PrimaryImage({
  location,
  displayWidth,
}: {
  location: InfLocation;
  displayWidth: number;
}) {
  const visual = resolveLocationVisual(location);
  const sourceLabel =
    visual.primarySource === "product"
      ? `Product image of ${location.product?.name ?? location.name}`
      : visual.primarySource === "child"
        ? `Compartment photo inside ${location.name}`
        : `Photo of ${location.name}`;

  return (
    <Image
      src={visual.primaryImage?.url ?? ""}
      alt={sourceLabel}
      displayWidth={displayWidth}
      className={cn(
        "size-full bg-card",
        visual.primarySource === "product" ? "object-contain" : "object-cover",
      )}
      fallback={<VisualFallback location={location} />}
    />
  );
}

function ChildContactSheet({
  location,
  interactive,
}: {
  location: InfLocation;
  interactive: boolean;
}) {
  const visual = resolveLocationVisual(location);
  if (visual.childVisuals.length === 0) return null;

  return (
    <div className="relative grid size-full grid-cols-2 gap-px bg-border">
      {visual.childVisuals.map((child) => {
        const image = (
          <Image
            key={child.id}
            src={child.image.url}
            alt={`${child.name} compartment`}
            displayWidth={360}
            className="size-full bg-card object-cover"
          />
        );
        return interactive ? (
          <Link
            key={child.id}
            to="/locations/$shortcode"
            params={{ shortcode: child.id }}
            aria-label={`Open ${child.name}`}
            className="min-h-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          >
            {image}
          </Link>
        ) : (
          <div key={child.id} className="min-h-0 overflow-hidden">
            {image}
          </div>
        );
      })}
      {visual.hiddenChildCount > 0 && (
        <span className="absolute right-1 bottom-1 bg-foreground px-1 font-mono text-2xs text-background tabular-nums">
          +{visual.hiddenChildCount}
        </span>
      )}
    </div>
  );
}

/**
 * One location visual grammar at three scales. Large surfaces separate the
 * vessel from its photographed compartments; dense rows keep one legible
 * cover and disclose structure as a count instead of miniaturising a mosaic.
 */
export function LocationVisual({
  location,
  variant,
  className,
  size = 40,
  interactive = false,
}: LocationVisualProps) {
  const visual = resolveLocationVisual(location);

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "relative shrink-0 overflow-hidden border border-[var(--border)] bg-card",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <PrimaryImage location={location} displayWidth={size} />
        {visual.childCount > 0 && (
          <span
            className="absolute right-0 bottom-0 flex min-w-4 items-center justify-center bg-foreground px-1 font-mono text-3xs text-background tabular-nums"
            title={`${visual.childCount} child ${visual.childCount === 1 ? "location" : "locations"}`}
          >
            {visual.childCount}
          </span>
        )}
      </div>
    );
  }

  const hasIdentity =
    visual.primarySource === "location" || visual.primarySource === "product";
  const hasChildren = visual.childVisuals.length > 0;
  const ownImageCount = location.images.filter(isDisplayableImageFile).length;
  const media = (
    <div
      className={cn(
        "grid size-full min-h-0 overflow-hidden bg-card",
        hasIdentity && hasChildren
          ? "grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          : "grid-cols-1",
      )}
    >
      {hasIdentity && (
        <div className="relative min-h-0 overflow-hidden border-border border-r">
          {interactive ? (
            <SourceLink location={location}>
              <PrimaryImage
                location={location}
                displayWidth={variant === "hero" ? 640 : 320}
              />
            </SourceLink>
          ) : (
            <PrimaryImage
              location={location}
              displayWidth={variant === "hero" ? 640 : 320}
            />
          )}
          {interactive && ownImageCount > 1 && (
            <Link
              to="/images"
              className="absolute bottom-1 left-1 bg-foreground px-1 font-mono text-2xs text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              +{ownImageCount - 1} photos
            </Link>
          )}
        </div>
      )}
      {hasChildren ? (
        <ChildContactSheet location={location} interactive={interactive} />
      ) : (
        !hasIdentity && <PrimaryImage location={location} displayWidth={320} />
      )}
    </div>
  );

  if (variant === "card") {
    return (
      <div className={cn("relative aspect-square overflow-hidden", className)}>
        {media}
        {visual.primarySource === "product" && (
          <Badge className="absolute top-1 left-1" variant="secondary">
            Product
          </Badge>
        )}
      </div>
    );
  }

  const children = location.children ?? [];
  const childLabel = locationChildGroupLabel(children);
  return (
    <figure
      className={cn(
        "my-0 overflow-hidden border border-[var(--border)] bg-card",
        className,
      )}
      aria-label={`Visual overview of ${location.name}`}
    >
      <div className="aspect-[4/3]">{media}</div>
      <figcaption className="grid grid-cols-2 border-border border-t bg-card">
        <span className="min-w-0 px-2 py-2 font-mono text-2xs text-muted-foreground uppercase">
          {visual.primarySource === "product"
            ? `Product · ${location.product?.name ?? "linked vessel"}`
            : visual.primarySource === "location"
              ? "Location photo"
              : "Location"}
        </span>
        <span className="min-w-0 border-border border-l px-2 py-2 text-right font-mono text-2xs text-muted-foreground uppercase">
          {visual.childCount > 0
            ? `${visual.childCount} ${childLabel}`
            : "No compartments"}
        </span>
      </figcaption>
    </figure>
  );
}
