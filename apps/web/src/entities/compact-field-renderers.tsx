import type { Entity } from "@cubby/schemas/entity";
import type { ProductListItem } from "@cubby/schemas/product";
import { productCategorySummary } from "@cubby/schemas/product-category-fields";
import type { ReactNode } from "react";
import { z } from "zod";

import { CategoryLabel } from "~/app/_components/products/CategoryLabel";
import { NoneValue } from "~/components/ui/none-value";

type CompactFieldRenderer = <TRecord extends object>(
  record: TRecord,
) => ReactNode | undefined;

function checkedRenderer<TSchema extends z.ZodType>(
  schema: TSchema,
  render: (record: z.output<TSchema>) => ReactNode,
): CompactFieldRenderer {
  return <TRecord extends object>(record: TRecord) => {
    const parsed = schema.safeParse(record);
    return parsed.success ? render(parsed.data) : undefined;
  };
}

const categoryRow = z.object({ category: productCategorySummary.nullable() });
const externalIdsRow = z.object({
  externalIds: z.array(z.object({ source: z.string() })),
});

const productCategory = checkedRenderer(categoryRow, (record) => (
  <CategoryLabel category={record.category} />
));

const productExternalIds = checkedRenderer(externalIdsRow, (record) => {
  const ids = record.externalIds;
  return ids.length > 0 ? (
    <span
      className="block truncate text-xs text-muted-foreground"
      title={ids.map((id) => id.source).join(", ")}
    >
      {ids.map((id) => id.source).join(", ")}
    </span>
  ) : (
    <NoneValue />
  );
});

// Both the stored category reference and the shelf's resolved projection have
// the same domain value. The row schema checks it before the renderer reads it.
const productRenderers = {
  categoryId: productCategory,
  category: productCategory,
  externalIds: productExternalIds,
} satisfies Partial<Record<keyof ProductListItem, CompactFieldRenderer>>;

/** A row-backed domain renderer shared by lists, relation tables, and shelves. */
export function compactFieldRendererFor(
  entity: Entity,
  fieldKey: string,
): CompactFieldRenderer | null {
  if (entity !== "product") return null;
  return (
    Object.entries(productRenderers).find(([key]) => key === fieldKey)?.[1] ??
    null
  );
}
