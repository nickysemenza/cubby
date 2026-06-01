import { formatDistanceToNow } from "date-fns";
import { Calendar } from "lucide-react";
import type { OrphanedProduct } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function OrphanedProductsList({
  products,
}: {
  products: OrphanedProduct[];
}) {
  return (
    <ProblemSection
      title="Orphaned Products"
      description="Products with no inventory entries and not linked to any recipe ingredients. These may be unused and can potentially be deleted."
      entity="product"
      items={products}
      emptyMessage="No orphaned products found. All products have inventory entries."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        details: [
          <div
            key="created"
            className="flex items-center gap-1 text-muted-foreground text-sm"
          >
            <Calendar className="h-3 w-3" />
            Created {formatDistanceToNow(product.createdAt)} ago
          </div>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}
