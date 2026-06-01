import { Badge } from "~/components/ui/badge";
import { EntityIcon } from "~/entities/entities";
import type { InvalidInventoryAmount } from "~/server/repo/problems";
import { ProblemSection } from "./problem-section";

export function InvalidInventoryAmountsList({
  entries,
}: {
  entries: InvalidInventoryAmount[];
}) {
  return (
    <ProblemSection
      title="Invalid Inventory Amounts"
      description="Inventory entries with zero or negative amounts that should be fixed or removed."
      entity="inventory"
      items={entries}
      emptyMessage="All inventory entries have valid positive amounts."
      groupBy={(items) => {
        const groups: { [key: string]: InvalidInventoryAmount[] } = {};
        items.forEach((item) => {
          const groupName =
            item.issue === "zero" ? "Zero Amounts" : "Negative Amounts";
          if (!groups[groupName]) {
            groups[groupName] = [];
          }
          groups[groupName]!.push(item);
        });
        return groups;
      }}
      renderItem={(entry) => ({
        title: entry.productName,
        details: [
          <div
            key="location"
            className="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {entry.locationName}
          </div>,
        ],
        badges: [
          <Badge key="issue" variant="destructive">
            {entry.issue === "zero" ? "Zero Amount" : "Negative Amount"}
          </Badge>,
          <code key="amount" className="rounded bg-muted px-2 py-1 text-sm">
            {entry.amount.value} {entry.amount.unit}
          </code>,
        ],
        route: { to: "/inventory/$id" as const, params: { id: entry.id } },
        editLabel: "Fix",
      })}
    />
  );
}
