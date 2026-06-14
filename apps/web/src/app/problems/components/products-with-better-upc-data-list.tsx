import { Download } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import type { ProductWithBetterUpcData } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

const GAP_LABELS: Record<keyof ProductWithBetterUpcData["gaps"], string> = {
  manufacturer: "Manufacturer",
  price: "Price",
  image: "Image",
};

export function ProductsWithBetterUpcDataList({
  products,
}: {
  products: ProductWithBetterUpcData[];
}) {
  return (
    <ProblemSection
      title="Better UPC data available"
      description="A fresh UPC lookup can fill in missing fields on these products. Re-import to pull the newer info."
      icon={Download}
      items={products}
      emptyMessage="No products have newer info available from UPC lookup."
      renderItem={(product) => {
        const gapBadges: ReactNode[] = (
          Object.keys(GAP_LABELS) as Array<keyof typeof GAP_LABELS>
        )
          .filter((key) => product.gaps[key])
          .map((key) => (
            <Badge key={key} variant="secondary">
              {GAP_LABELS[key]}
            </Badge>
          ));

        return {
          title: product.name,
          subtitle: `by ${product.manufacturer}`,
          badges: [
            ...gapBadges,
            <code key="upc" className="rounded bg-muted px-2 py-1 text-sm">
              {product.upc}
            </code>,
          ],
          route: { to: "/products/$id" as const, params: { id: product.id } },
          editLabel: "Re-import",
        };
      }}
    />
  );
}
