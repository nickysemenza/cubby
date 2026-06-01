import { formatDistanceToNow } from "date-fns";
import { Calendar, DollarSign } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import type { ProductWithoutMappings } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function ProductsWithoutMappingsList({
  products,
}: {
  products: ProductWithoutMappings[];
}) {
  return (
    <ProblemSection
      title="Products Without Pricing"
      description="Products missing unit mappings. Add pricing information to enable value calculations."
      icon={DollarSign}
      items={products}
      emptyMessage="All products have unit mappings for pricing information."
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
        badges: [
          <Badge key="no-mappings" variant="outline" className="w-fit">
            No unit mappings
          </Badge>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
        editLabel: "Add Pricing",
      })}
    />
  );
}
