import {
  displayCoverField,
  displayImagesField,
  type DisplayCover,
} from "@cubby/schemas/display-images";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";

/** Selected covers are authoritative; complete reads retain their full image envelope. */
export function rowDisplayCover<Row extends object>(row: Row): DisplayCover {
  if ("displayCover" in row) return displayCoverField.parse(row.displayCover);
  const envelope = fieldEnvelopeFor(row, "displayImages");
  const images = envelope
    ? (displayImagesField.nullable().parse(fieldValueOf(envelope)) ?? [])
    : [];
  return { image: images[0] ?? null, count: images.length };
}
