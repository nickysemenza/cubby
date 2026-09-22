import { NoneValue } from "~/components/ui/none-value";

import type { EntityDetailFieldRenderers } from "./index";

/**
 * Shared shape for any `captureLocation`-kind json field — today
 * `Image.captureLocation` and `ImageSighting.location`, and reusable by any
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

/** Shared shape between `Image.provenanceEvidence` and nothing else yet, but
 * kept generic for a future basis-carrying field. */
interface ProvenanceEvidence {
  basis: string;
  ruleId?: string;
  detail?: string;
}

function renderProvenanceEvidence(evidence: ProvenanceEvidence | null) {
  if (!evidence) return <NoneValue />;
  const parts = [evidence.basis];
  if (evidence.ruleId) parts.push(evidence.ruleId);
  if (evidence.detail) parts.push(evidence.detail);
  return <span className="text-xs">{parts.join(" · ")}</span>;
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

export const imageDetailFields = {
  "image-capture-location": (image) => ({
    value: renderCoordinates(image.captureLocation),
  }),
  "image-provenance-evidence": (image) => ({
    value: renderProvenanceEvidence(image.provenanceEvidence),
  }),
} satisfies EntityDetailFieldRenderers<"image">;

export const imageSightingDetailFields = {
  "image-sighting-location": (sighting) => ({
    value: renderCoordinates(sighting.location),
  }),
  "image-sighting-camera": (sighting) => ({
    value: renderCamera(sighting.camera),
  }),
} satisfies EntityDetailFieldRenderers<"imageSighting">;
