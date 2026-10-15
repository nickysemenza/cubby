import type { ImageSightingOut } from "@cubby/schemas/image-sighting";

import { householdLocalDate } from "~/lib/household-date";
import { NoneValue } from "~/ui/primitives/none-value";

import type { EntityDetailFieldRenderers } from "./index";

/**
 * Shared shape for any `captureLocation`-kind json field — today
 * `Image.captureLocation` and each sighting's `location`, and reusable by any
 * future coordinate field without a new renderer: this one function renders
 * "lat, lng · Open in Maps" (plus optional elevation/accuracy) for any of
 * them.
 */
interface CaptureCoordinates {
  lat: number;
  lng: number;
  altitude?: number;
  horizontalAccuracy?: number;
}

function renderCoordinates(location: CaptureCoordinates | null) {
  if (!location) return <NoneValue />;
  const parts = [`${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`];
  if (location.altitude !== undefined)
    parts.push(`${location.altitude.toFixed(0)} m elevation`);
  if (location.horizontalAccuracy !== undefined)
    parts.push(`±${location.horizontalAccuracy.toFixed(0)} m`);
  return (
    <span className="font-mono text-xs">
      {parts.join(" · ")} ·{" "}
      <a
        className="font-sans underline"
        href={`https://maps.apple.com/?ll=${location.lat},${location.lng}`}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        Open in Maps
      </a>
    </span>
  );
}

interface Camera {
  make?: string;
  model?: string;
  lens?: string;
  software?: string;
}

function renderCamera(camera: Camera | null) {
  if (!camera) return <NoneValue />;
  const parts = [
    camera.make,
    camera.model,
    camera.lens,
    camera.software,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? (
    <span className="text-xs">{parts.join(" · ")}</span>
  ) : (
    <NoneValue />
  );
}

const SOURCE_TYPE_LABEL = {
  userLibrary: "User library",
  cloudShared: "Cloud shared",
  iTunesSynced: "iTunes synced",
} as const satisfies Record<ImageSightingOut["sourceType"], string>;

function renderSightings(sightings: readonly ImageSightingOut[] | undefined) {
  if (!sightings || sightings.length === 0) return <NoneValue />;
  return (
    <ul className="flex flex-col gap-2 text-xs">
      {sightings.map((sighting) => (
        <li key={[sighting.ledgerPartyId, sighting.assetKey].join(":")}>
          <span className="font-medium">
            {sighting.ownerName ?? "Unknown owner"} ·{" "}
            {sighting.deviceName ?? "Unknown device"}
          </span>{" "}
          <span className="text-muted-foreground">
            {[
              SOURCE_TYPE_LABEL[sighting.sourceType],
              householdLocalDate(sighting.capturedAt ?? sighting.observedAt),
              sighting.placeName,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {sighting.location ? (
            <div>{renderCoordinates(sighting.location)}</div>
          ) : null}
          {sighting.camera ? <div>{renderCamera(sighting.camera)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export const imageDetailFields = {
  "image-capture-location": (image) => ({
    value: renderCoordinates(image.captureLocation),
  }),
  "image-sightings": (image) => ({
    value: renderSightings(image.sightings),
  }),
} satisfies EntityDetailFieldRenderers<"image">;
