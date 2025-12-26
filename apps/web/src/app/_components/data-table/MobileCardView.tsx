"use client";

import { flexRender, type Table as ITable } from "@tanstack/react-table";
import { Bug } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Empty, EmptyTitle, EmptyDescription } from "~/components/ui/empty";
import { useDebug } from "~/hooks/useDebug";
import { DebugDialog } from "./DebugDialog";
import type { ReactNode } from "react";
import { EntityPreviewCard } from "~/components/entity/entity-preview-card";
import { extractEntityTitle, getEntityImage } from "~/lib/entity-utils";

interface MobileCardViewProps<TItem> {
  table: ITable<TItem>;
}

type FieldCategory = "hero" | "compact" | "medium" | "wide";

interface CategorizedField {
  id: string;
  displayHeader: string;
  content: ReactNode;
  category: FieldCategory;
}

function categorizeField(
  columnId: string,
  metaCategory?: FieldCategory,
): FieldCategory {
  // Check for meta override first
  if (metaCategory) {
    return metaCategory;
  }

  // Hero fields: image and name (primary identification)
  if (columnId === "image" || columnId === "name") {
    return "hero";
  }

  // Compact fields: short IDs, codes, dates, simple text
  if (
    columnId.includes("id") ||
    columnId.includes("upc") ||
    columnId.includes("ndb") ||
    columnId.includes("createdAt") ||
    columnId.includes("model") ||
    columnId === "fdc_id"
  ) {
    return "compact";
  }

  // Wide fields: complex tables, long descriptions, complex components
  if (
    columnId.includes("food") ||
    columnId.includes("nutrition") ||
    columnId.includes("unitMapping") ||
    columnId.includes("inventoryEntry") ||
    columnId.includes("meta")
  ) {
    return "wide";
  }

  // Medium fields: everything else (manufacturer, etc.)
  return "medium";
}

export function MobileCardView<TItem>({ table }: MobileCardViewProps<TItem>) {
  const { isDebugEnabled } = useDebug();

  return (
    <div className="block space-y-4 lg:hidden">
      {table.getRowModel().rows?.length ? (
        table.getRowModel().rows.map((row) => {
          // Categorize all fields for this row
          const categorizedFields: CategorizedField[] = row
            .getVisibleCells()
            .map((cell) => {
              const header = cell.column.columnDef.header;
              let headerText = cell.column.id;

              if (typeof header === "string") {
                headerText = header;
              }

              const displayHeader = headerText
                .replace(/([A-Z])/g, " $1")
                .replace(/^./, (str) => str.toUpperCase())
                .trim();

              const content = flexRender(
                cell.column.columnDef.cell,
                cell.getContext(),
              );
              const metaCategory = cell.column.columnDef.meta?.mobileCategory;
              const category = categorizeField(cell.column.id, metaCategory);

              return {
                id: cell.id,
                displayHeader,
                content,
                category,
              };
            });

          // Group fields by category
          const heroFields = categorizedFields.filter(
            (f) => f.category === "hero",
          );
          const compactFields = categorizedFields.filter(
            (f) => f.category === "compact",
          );
          const mediumFields = categorizedFields.filter(
            (f) => f.category === "medium",
          );
          const wideFields = categorizedFields.filter(
            (f) => f.category === "wide",
          );

          // Extract raw data values directly from the row
          const rowData = row.original as Record<string, unknown>;

          // Get title using utility function
          const titleString = extractEntityTitle(rowData);

          // Get image using utility function, with fallback to rendered field
          const entityImage = getEntityImage(rowData);
          const imageField = heroFields.find(
            (f) => f.displayHeader.toLowerCase() === "image",
          );
          const imageContent = entityImage || imageField?.content;

          // Create details from medium and compact fields
          const details = [...mediumFields, ...compactFields].map((field) => (
            <div key={field.id} className="flex items-center justify-between">
              <span className="font-medium text-muted-foreground text-xs">
                {field.displayHeader}:
              </span>
              <span className="text-sm">{field.content}</span>
            </div>
          ));

          // Create badges from wide fields (simplified representation)
          const badges = wideFields.map((field) => (
            <div key={field.id} className="text-muted-foreground text-xs">
              {field.displayHeader}
            </div>
          ));

          const footer = isDebugEnabled ? (
            <div className="flex items-center justify-between">
              <span className="font-medium text-muted-foreground text-sm">
                Debug
              </span>
              <DebugDialog
                data={row.original}
                title={`Debug Data - Row ${row.id}`}
                trigger={
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <Bug className="h-4 w-4" />
                    <span className="sr-only">Debug row data</span>
                  </Button>
                }
              />
            </div>
          ) : undefined;

          return (
            <EntityPreviewCard
              key={row.id}
              title={titleString}
              image={imageContent}
              details={details}
              badges={badges}
              footer={footer}
              variant="compact"
              className="shadow-sm"
            />
          );
        })
      ) : (
        <Empty className="py-8">
          <EmptyTitle>No results</EmptyTitle>
          <EmptyDescription>
            Try adjusting your search or filters
          </EmptyDescription>
        </Empty>
      )}
    </div>
  );
}
