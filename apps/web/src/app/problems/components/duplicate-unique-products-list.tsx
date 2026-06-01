import { Link } from "@tanstack/react-router";
import { Badge } from "~/components/ui/badge";
import { EntityIcon } from "~/entities/entities";
import type { DuplicateUniqueProduct } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function DuplicateUniqueProductsList({
  products,
}: {
  products: DuplicateUniqueProduct[];
}) {
  return (
    <ProblemSection
      title="Duplicate Unique Products"
      description="Products marked as unique (expectedQuantity=1) but found in multiple locations. These should be consolidated or have their expectedQuantity updated."
      entity="product"
      items={products}
      emptyMessage="No duplicate unique products found. All products with expectedQuantity=1 are in single locations."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: product.locations.map((location) => (
          <Link
            key={location.id}
            to="/locations/$id"
            params={{ id: location.id }}
          >
            <Badge
              variant="outline"
              className="flex items-center gap-1 hover:bg-accent"
            >
              <EntityIcon entity="location" colored className="h-3 w-3" />
              {location.name}
            </Badge>
          </Link>
        )),
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}
