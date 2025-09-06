"use client";

import { flexRender, type Table as ITable } from "@tanstack/react-table";
import { Bug } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useDebug } from "~/hooks/useDebug";
import { DebugDialog } from "./DebugDialog";
import { type ReactNode } from "react";

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

          return (
            <div
              key={row.id}
              className="bg-card rounded-lg border p-4 shadow-sm"
            >
              {/* Hero Section - Image and Name */}
              {heroFields.length > 0 && (
                <div className="mb-4 flex items-start gap-3 border-b pb-3">
                  {heroFields.map((field) => (
                    <div
                      key={field.id}
                      className={
                        field.displayHeader.toLowerCase() === "image"
                          ? "flex-shrink-0"
                          : "min-w-0 flex-1 overflow-hidden"
                      }
                    >
                      {field.displayHeader.toLowerCase() === "image" ? (
                        field.content
                      ) : (
                        <div className="min-w-0">
                          <div className="min-w-0 text-base leading-tight font-semibold break-words">
                            {field.content}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Medium and Compact Fields Grid */}
              {(mediumFields.length > 0 || compactFields.length > 0) && (
                <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3">
                  {[...mediumFields, ...compactFields].map((field) => (
                    <div
                      key={field.id}
                      className={`min-w-0 ${compactFields.includes(field) ? "text-sm" : ""}`}
                    >
                      <div className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
                        {field.displayHeader}
                      </div>
                      <div className="min-w-0 overflow-hidden text-sm break-words">
                        {field.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Wide Fields - Full Width */}
              {wideFields.length > 0 && (
                <div className="space-y-4">
                  {wideFields.map((field) => (
                    <div key={field.id} className="min-w-0">
                      <div className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                        {field.displayHeader}
                      </div>
                      <div className="min-w-0 overflow-hidden text-sm">
                        {field.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Debug section for mobile */}
              {isDebugEnabled && (
                <div className="mt-4 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-sm font-medium">
                      Debug
                    </span>
                    <DebugDialog
                      data={row.original}
                      title={`Debug Data - Row ${row.id}`}
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          <Bug className="h-4 w-4" />
                          <span className="sr-only">Debug row data</span>
                        </Button>
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })
      ) : (
        <div className="text-muted-foreground py-8 text-center">
          No results.
        </div>
      )}
    </div>
  );
}
