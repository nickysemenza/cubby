import { displayImagesField } from "@cubby/schemas/display-images";
import { listChildCountSchema } from "@cubby/schemas/pagination";
import { z } from "zod";

const childCountRowSchema = z.object({ childCount: listChildCountSchema });
/**
 * A tree scope's `childCount` is a list-row fact the entity's output schema
 * does not declare, so parsing a row strips it; carry it from each source row
 * onto its parsed row.
 */
export const withChildCounts = <Row>(
  parsed: readonly Row[],
  source: readonly unknown[],
): Row[] =>
  parsed.map((row, index) => {
    const { childCount } = childCountRowSchema.parse(source[index] ?? {});
    return childCount === undefined
      ? row
      : Object.assign({}, row, { childCount });
  });

const displayImagesRowSchema = z.object({
  displayImages: displayImagesField.optional(),
});
/**
 * The plan resolves `displayImages` for every list row, but an entity's
 * output schema may not declare them; carry them so the kernel's media pass
 * finds them and skips its own shortcode-then-images round trips.
 */
export const withDisplayImages = <Row>(
  parsed: readonly Row[],
  source: readonly unknown[],
): Row[] =>
  parsed.map((row, index) => {
    const { displayImages } = displayImagesRowSchema.parse(source[index] ?? {});
    return displayImages === undefined
      ? row
      : Object.assign({}, row, { displayImages });
  });
