import { type ImageOut, isDisplayableImageFile } from "@cubby/schemas/image";
import {
  type InfLocation,
  type LocationType,
  locationCoverImage,
} from "@cubby/schemas/location";
import pluralize from "pluralize";

const MAX_CHILD_PREVIEWS = 4;

type LocationPrimaryVisualSource = "location" | "product" | "child" | "none";

interface LocationChildVisual {
  id: InfLocation["id"];
  name: string;
  image: ImageOut;
}

export interface ResolvedLocationVisual {
  primaryImage: ImageOut | null;
  primarySource: LocationPrimaryVisualSource;
  childVisuals: LocationChildVisual[];
  childCount: number;
  hiddenChildCount: number;
}

export interface ResolvedLocationPrimaryVisual {
  image: ImageOut | null;
  source: Exclude<LocationPrimaryVisualSource, "child">;
}

const firstDisplayable = (images: readonly ImageOut[] | undefined) =>
  images?.find(isDisplayableImageFile) ?? null;

export function resolveLocationPrimaryVisual(
  location: Pick<InfLocation, "images" | "product">,
): ResolvedLocationPrimaryVisual {
  const image = locationCoverImage(location);
  if (!image) return { image: null, source: "none" };
  return {
    image,
    source: location.images.includes(image) ? "location" : "product",
  };
}

/**
 * Resolve visual identity without changing image ownership. Product and child
 * images stay references to their real entities; callers decide whether the
 * presentation is interactive or sits inside an existing location link.
 */
export function resolveLocationVisual(
  location: Pick<InfLocation, "images" | "product" | "children">,
): ResolvedLocationVisual {
  const primary = resolveLocationPrimaryVisual(location);
  const allChildVisuals = (location.children ?? []).flatMap((child) => {
    const image = firstDisplayable(child.images);
    return image ? [{ id: child.id, name: child.name, image }] : [];
  });
  const childVisuals = allChildVisuals.slice(0, MAX_CHILD_PREVIEWS);
  const firstChildImage = childVisuals[0]?.image ?? null;

  return {
    primaryImage: primary.image ?? firstChildImage,
    primarySource:
      primary.source !== "none"
        ? primary.source
        : firstChildImage
          ? "child"
          : "none",
    childVisuals,
    childCount: location.children?.length ?? 0,
    hiddenChildCount: Math.max(
      0,
      (location.children?.length ?? 0) - childVisuals.length,
    ),
  };
}

/** A homogeneous direct-child set earns a useful physical label. */
export function locationChildGroupLabel(
  children: ReadonlyArray<Pick<InfLocation, "type">>,
): string {
  if (children.length === 0) return "Locations";
  const types = new Set(
    children
      .map((child) => child.type)
      .filter((type): type is LocationType => type != null),
  );
  if (types.size !== 1 || children.some((child) => child.type == null)) {
    return "Compartments";
  }
  const [type] = types;
  return pluralize(type ?? "compartment", children.length);
}
