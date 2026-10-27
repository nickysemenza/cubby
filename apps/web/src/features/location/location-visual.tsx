import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { LocationTreeNode } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import { locationChildGroupLabel } from "~/lib/location-child-label";
import { cn } from "~/lib/utils";
import { Badge } from "~/ui/primitives/badge";
import { Image } from "~/ui/primitives/image";

import { LocationIcon } from "../../entity/presentation/location-icons";
import { resolveLocationVisual } from "../../entity/presentation/location-visual-resolver";

type LocationVisualVariant = "hero" | "card" | "compact";

interface LocationVisualProps {
  location: LocationTreeNode;
  variant: LocationVisualVariant;
  className?: string;
  /** Compact rendered width; ignored by card/hero variants. */
  size?: number;
  /** Hero media can link each source; cards/rows already own their outer link. */
  interactive?: boolean;
  showChildCount?: boolean;
}

function VisualFallback({ location }: { location: LocationTreeNode }) {
  return (
    <LocationIcon
      type={fieldValueOf(location.fields.type)}
      product={fieldValueOf(location.fields.product)}
      size={20}
      className="text-muted-foreground"
    />
  );
}

function SourceLink({
  location,
  children,
}: {
  location: LocationTreeNode;
  children: ReactNode;
}) {
  const image = useEntityDisplayImage(
    {
      entityKind: "location",
      entityId: location.id,
    },
    location.fields.displayImages.result.kind === "missing"
      ? undefined
      : (fieldValueOf(location.fields.displayImages)?.[0] ?? null),
  );
  const visual = resolveLocationVisual(location, image);
  const product = fieldValueOf(location.fields.product);
  if (visual.primarySource === "product" && product) {
    return (
      <Link
        to="/products/$shortcode"
        params={{ shortcode: product.id }}
        aria-label={`Open product ${product.name}`}
        className="block size-full focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
      >
        {children}
      </Link>
    );
  }
  const ownPhoto = (fieldValueOf(location.fields.images) ?? []).find(
    (owned) =>
      owned.url ===
      (visual.primaryImage?.representations?.original ??
        visual.primaryImage?.url),
  );
  if (visual.primarySource === "location" && ownPhoto) {
    return (
      <Link
        to="/images/$shortcode"
        params={{ shortcode: ownPhoto.id }}
        aria-label={`Open photo of ${location.name}`}
        className="block size-full focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
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
  location: LocationTreeNode;
  displayWidth: number;
}) {
  const image = useEntityDisplayImage(
    {
      entityKind: "location",
      entityId: location.id,
    },
    location.fields.displayImages.result.kind === "missing"
      ? undefined
      : (fieldValueOf(location.fields.displayImages)?.[0] ?? null),
  );
  const visual = resolveLocationVisual(location, image);
  const sourceLabel =
    visual.primarySource === "product"
      ? `Product image of ${fieldValueOf(location.fields.product)?.name ?? location.name}`
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
  location: LocationTreeNode;
  interactive: boolean;
}) {
  const image = useEntityDisplayImage(
    {
      entityKind: "location",
      entityId: location.id,
    },
    location.fields.displayImages.result.kind === "missing"
      ? undefined
      : (fieldValueOf(location.fields.displayImages)?.[0] ?? null),
  );
  const visual = resolveLocationVisual(location, image);
  if (visual.childVisuals.length === 0) return null;

  return (
    <div className="relative grid size-full grid-cols-2 gap-px bg-border">
      {visual.childVisuals.map((child) => {
        const image = (
          <Image
            key={child.id}
            src={child.image.url}
            alt={`${child.name} compartment`}
            displayWidth={240}
            className="size-full bg-card object-cover"
          />
        );
        return interactive ? (
          <Link
            key={child.id}
            to="/locations/$shortcode"
            params={{ shortcode: child.id }}
            aria-label={`Open ${child.name}`}
            className="min-h-0 overflow-hidden focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset"
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

function LocationVisualMedia({
  location,
  variant,
  interactive,
}: Pick<LocationVisualProps, "location" | "variant" | "interactive">) {
  const image = useEntityDisplayImage(
    {
      entityKind: "location",
      entityId: location.id,
    },
    location.fields.displayImages.result.kind === "missing"
      ? undefined
      : (fieldValueOf(location.fields.displayImages)?.[0] ?? null),
  );
  const visual = resolveLocationVisual(location, image);
  const hasIdentity =
    visual.primarySource === "location" || visual.primarySource === "product";
  const hasChildren = visual.childVisuals.length > 0;
  const ownImageCount = (fieldValueOf(location.fields.images) ?? []).filter(
    isDisplayableImageFile,
  ).length;
  // The hero is edge-to-edge on mobile (DetailPlate's w-screen slot); every
  // other variant is a card or rail tile.
  const primaryDisplayWidth = variant === "hero" ? 640 : 320;
  const primaryImage = (
    <PrimaryImage location={location} displayWidth={primaryDisplayWidth} />
  );
  return (
    <div
      className={cn(
        "grid size-full min-h-0 overflow-hidden bg-card",
        hasIdentity && hasChildren
          ? "grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          : "grid-cols-1",
      )}
    >
      {hasIdentity && (
        <div className="relative min-h-0 overflow-hidden border-r border-border">
          {interactive ? (
            <SourceLink location={location}>{primaryImage}</SourceLink>
          ) : (
            primaryImage
          )}
          {interactive && ownImageCount > 1 && (
            <Link
              to="/images"
              className="absolute bottom-1 left-1 bg-foreground px-1 font-mono text-2xs text-background focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            >
              +{ownImageCount - 1} photos
            </Link>
          )}
        </div>
      )}
      {hasChildren ? (
        <ChildContactSheet
          location={location}
          interactive={interactive ?? false}
        />
      ) : (
        !hasIdentity && (
          <PrimaryImage
            location={location}
            displayWidth={primaryDisplayWidth}
          />
        )
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
  showChildCount = true,
}: LocationVisualProps) {
  const image = useEntityDisplayImage(
    {
      entityKind: "location",
      entityId: location.id,
    },
    location.fields.displayImages.result.kind === "missing"
      ? undefined
      : (fieldValueOf(location.fields.displayImages)?.[0] ?? null),
  );
  const visual = resolveLocationVisual(location, image);

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
        {showChildCount && visual.childCount > 0 && (
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

  const media = (
    <LocationVisualMedia
      location={location}
      variant={variant}
      interactive={interactive}
    />
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
  const childLabel = locationChildGroupLabel(
    children.map((child) => fieldValueOf(child.fields.type)),
  );
  return (
    <figure
      className={cn(
        "my-0 overflow-hidden border border-[var(--border)] bg-card",
        className,
      )}
      aria-label={`Visual overview of ${location.name}`}
    >
      <div
        className={cn(
          "aspect-video md:aspect-[4/3]",
          visual.primarySource === "none" && "max-md:aspect-auto max-md:h-14",
        )}
      >
        {media}
      </div>
      <figcaption className="grid grid-cols-2 border-t border-border bg-card">
        <span className="min-w-0 px-2 py-1 text-xs font-medium text-muted-foreground sm:py-2">
          {visual.primarySource === "product"
            ? `Product · ${fieldValueOf(location.fields.product)?.name ?? "linked vessel"}`
            : visual.primarySource === "location"
              ? "Location photo"
              : "Location"}
        </span>
        <span className="min-w-0 border-l border-border px-2 py-1 text-right text-xs font-medium text-muted-foreground sm:py-2">
          {visual.childCount > 0
            ? `${visual.childCount} ${childLabel}`
            : "No compartments"}
        </span>
      </figcaption>
    </figure>
  );
}
