import { isDocumentFile } from "@cubby/schemas/image";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import type { InventoryItem } from "./types";

const MAX_THUMBS = 4;

function productDisplayName(name: string): string {
  return isMiscProduct(name) ? getMiscDisplayName(name) : name;
}

/**
 * A one-line peek at a location's direct contents — up to four product
 * thumbnails (with a +N overflow chip) plus a truncated comma-separated name
 * list. Renders nothing when the location has no direct items, so callers can
 * drop it in unconditionally. Direct items only; nested totals stay in the
 * row's "N loc · M items" count.
 */
export function LocationContentsPreview({ items }: { items: InventoryItem[] }) {
  if (items.length === 0) return null;

  const thumbs = items.slice(0, MAX_THUMBS);
  const overflow = items.length - thumbs.length;
  const nameLine = items
    .map((item) => productDisplayName(item.product.name))
    .join(", ");

  return (
    <Row align="center" gap="xs" className="mt-2 min-w-0">
      <Row gap="tight" className="shrink-0">
        {thumbs.map((item) => (
          <Image
            key={item.id}
            src={item.product.images.find((img) => !isDocumentFile(img))?.url}
            alt={productDisplayName(item.product.name)}
            displayWidth={64}
            className="h-8 w-8 shrink-0 border border-[var(--border)] object-cover"
          />
        ))}
        {overflow > 0 && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--border)] bg-muted font-mono text-2xs text-muted-foreground">
            +{overflow}
          </span>
        )}
      </Row>
      <Description size="xs" className="min-w-0 flex-1 truncate">
        {nameLine}
      </Description>
    </Row>
  );
}
