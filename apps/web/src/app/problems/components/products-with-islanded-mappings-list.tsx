import { Network } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import type { ProductWithIslandedMappings } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function ProductsWithIslandedMappingsList({
  products,
}: {
  products: ProductWithIslandedMappings[];
}) {
  return (
    <ProblemSection
      title="Disconnected Unit Mappings"
      description="Products with unit mappings split into isolated groups that can't convert between each other. Add connecting mappings to enable full conversions."
      icon={Network}
      items={products}
      emptyMessage="All products have connected unit mapping graphs."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <Badge key="islands" variant="destructive">
            {product.islandCount} islands
          </Badge>,
          ...product.islands.map((island) => (
            <Badge
              key={island.exampleUnit}
              variant="outline"
              className="text-xs"
            >
              {island.exampleUnit}
            </Badge>
          )),
        ],
        details: product.islands.map((island, i) => (
          <div
            key={island.exampleUnit}
            className="text-muted-foreground text-sm"
          >
            Island {i + 1}: {island.units.join(", ")}
          </div>
        )),
        route: { to: "/products/$id" as const, params: { id: product.id } },
        editLabel: "View",
      })}
    />
  );
}
