import { type ImageOut, isDisplayableImageFile } from "@cubby/schemas/image";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import { type InfLocation } from "@cubby/schemas/location";

const MAX_CHILD_PREVIEWS = 4;

type LocationPrimaryVisualSource = "location" | "product" | "none";

interface LocationChildVisual {
  id: InfLocation["id"];
  name: string;
  image: ImageOut;
}

export interface ResolvedLocationVisual {
  primaryImage: ImageUrlSummary | null;
  primarySource: LocationPrimaryVisualSource;
  childVisuals: LocationChildVisual[];
  childCount: number;
  hiddenChildCount: number;
}

export interface ResolvedLocationPrimaryVisual {
  image: ImageUrlSummary | null;
  source: LocationPrimaryVisualSource;
}

const firstDisplayable = (images: readonly ImageOut[] | undefined) =>
  images?.find(isDisplayableImageFile) ?? null;

export function resolveLocationPrimaryVisual(
  location: Pick<InfLocation, "images" | "product" | "displayImages">,
  resolvedImage: ImageUrlSummary | null = null,
): ResolvedLocationPrimaryVisual {
  const image = resolvedImage ?? location.displayImages?.[0] ?? null;
  if (!image) return { image: null, source: "none" };
  return {
    image: { ...image, url: preferredImageUrl(image) },
    source:
      location.images.some(
        (own) => own.url === (image.representations?.original ?? image.url),
      ) || !location.product
        ? "location"
        : "product",
  };
}

/**
 * Canonical display images own identity. The contact sheet separately shows
 * explicitly owned compartment photos; it never substitutes one as the parent cover.
 * Resolve visual identity without changing image ownership. Product and child
 * images stay references to their real entities; callers decide whether the
 * presentation is interactive or sits inside an existing location link.
 */
export function resolveLocationVisual(
  location: Pick<
    InfLocation,
    "images" | "product" | "children" | "displayImages"
  >,
  resolvedImage: ImageUrlSummary | null = null,
): ResolvedLocationVisual {
  const primary = resolveLocationPrimaryVisual(location, resolvedImage);
  const allChildVisuals = (location.children ?? []).flatMap((child) => {
    const image = firstDisplayable(child.images);
    return image ? [{ id: child.id, name: child.name, image }] : [];
  });
  const childVisuals = allChildVisuals.slice(0, MAX_CHILD_PREVIEWS);

  return {
    primaryImage: primary.image,
    primarySource: primary.source,
    childVisuals,
    childCount: location.children?.length ?? 0,
    hiddenChildCount: Math.max(
      0,
      (location.children?.length ?? 0) - childVisuals.length,
    ),
  };
}
