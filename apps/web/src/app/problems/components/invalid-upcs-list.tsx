import { Zap } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import type { InvalidUPC } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function InvalidUPCsList({ products }: { products: InvalidUPC[] }) {
  return (
    <ProblemSection
      title="Invalid UPCs"
      description="Products with invalid UPC formats or duplicate UPC codes."
      icon={Zap}
      items={products}
      emptyMessage="No invalid UPC codes found. All UPCs are properly formatted and unique."
      groupBy={(items) => {
        const groups: { [key: string]: InvalidUPC[] } = {};
        items.forEach((item) => {
          const groupName =
            item.issue === "invalid_format"
              ? "Invalid Format"
              : "Duplicate UPCs";
          if (!groups[groupName]) {
            groups[groupName] = [];
          }
          groups[groupName]!.push(item);
        });
        return groups;
      }}
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <Badge key="issue" variant="destructive">
            {product.issue === "invalid_format"
              ? "Invalid UPC"
              : "Duplicate UPC"}
          </Badge>,
          <code key="upc" className="rounded bg-muted px-2 py-1 text-sm">
            {product.upc}
          </code>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
        editLabel: "Fix",
      })}
    />
  );
}
