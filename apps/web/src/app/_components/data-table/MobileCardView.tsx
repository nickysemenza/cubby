import { useNavigate } from "@tanstack/react-router";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { Bug } from "lucide-react";
import type { ReactNode } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDebug } from "~/hooks/useDebug";
import { extractEntityTitle, getEntityImage } from "~/lib/entity-utils";
import { DebugDialog } from "./DebugDialog";

export type EntityType =
  | "products"
  | "locations"
  | "inventory"
  | "recipes"
  | "ingredients"
  | "images";

interface MobileCardViewProps<TItem> {
  table: ITable<TItem>;
  /** Entity type for navigation - when provided, cards become clickable */
  entityType?: EntityType;
  /**
   * Custom render function for mobile cards.
   * Receives the row and the default card content, allowing full customization.
   * Useful for tables with inline editing or special mobile UX.
   */
  renderMobileCard?: (row: Row<TItem>, defaultContent: ReactNode) => ReactNode;
}

type FieldCategory = "hero" | "compact" | "medium" | "wide";

interface CategorizedField {
  id: string;
  displayHeader: string;
  content: ReactNode;
  category: FieldCategory;
}

/**
 * Check if a field has meaningful content worth displaying
 */
function hasContent(content: ReactNode): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed !== "" && trimmed !== "—";
  }
  return true;
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

export function MobileCardView<TItem>({
  table,
  entityType,
  renderMobileCard,
}: MobileCardViewProps<TItem>) {
  const { isDebugEnabled } = useDebug();
  const navigate = useNavigate();

  // Check if table has row selection enabled
  const hasRowSelection = table.options.enableRowSelection !== false;
  const hasSelectColumn = table
    .getAllColumns()
    .some((col) => col.id === "select");
  const isSelectable = hasRowSelection && hasSelectColumn;

  return (
    <div className="block space-y-4 lg:hidden">
      {table.getRowModel().rows?.length ? (
        table.getRowModel().rows.map((row) => {
          // Extract actions cell content (for MobileCard.actions slot)
          const actionsCell = row
            .getVisibleCells()
            .find((cell) => cell.column.id === "actions");
          const actionsContent = actionsCell
            ? flexRender(
                actionsCell.column.columnDef.cell,
                actionsCell.getContext(),
              )
            : undefined;

          // Categorize all fields for this row, filtering out "select" and "actions" columns
          const categorizedFields: CategorizedField[] = row
            .getVisibleCells()
            .filter(
              (cell) =>
                cell.column.id !== "select" && cell.column.id !== "actions",
            )
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

          // Get title using generic utility function (no cast needed)
          const titleString = extractEntityTitle(row.original);

          // Extract raw data for image extraction
          const rowData = row.original as Record<string, unknown>;

          // Get image using utility function, with fallback to rendered field
          const entityImage = getEntityImage(rowData);
          const imageField = heroFields.find(
            (f) => f.displayHeader.toLowerCase() === "image",
          );
          const imageContent = entityImage || imageField?.content;

          // Create details from medium and compact fields (filter empty)
          const details = [...mediumFields, ...compactFields]
            .filter((field) => hasContent(field.content))
            .map((field) => (
              <div
                key={field.id}
                className="flex min-w-0 items-center justify-between gap-2"
              >
                <span className="shrink-0 font-medium text-muted-foreground text-xs">
                  {field.displayHeader}:
                </span>
                <span className="truncate text-right text-sm">
                  {field.content}
                </span>
              </div>
            ));

          // Create badges from wide fields with their content (filter empty)
          const badges = wideFields
            .filter((field) => hasContent(field.content))
            .map((field) => (
              <div
                key={field.id}
                className="flex min-w-0 items-center gap-1 text-xs"
              >
                <span className="shrink-0 text-muted-foreground">
                  {field.displayHeader}:
                </span>
                <span className="min-w-0 truncate">{field.content}</span>
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

          // Get entity ID for navigation
          const entityId = rowData.id as string | undefined;
          const handleClick =
            entityType && entityId
              ? () => {
                  navigate({
                    to: `/${entityType}/$id`,
                    params: { id: entityId },
                  });
                }
              : undefined;

          // Build default card content
          const defaultContent = (
            <div className="space-y-2">
              {/* Title with image */}
              <div className="flex items-start gap-3">
                {imageContent && (
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded">
                    {imageContent}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{titleString}</p>
                </div>
              </div>

              {/* Details */}
              {details.length > 0 && <div className="space-y-1">{details}</div>}

              {/* Badges */}
              {badges.length > 0 && <div className="space-y-1">{badges}</div>}

              {/* Debug footer */}
              {footer}
            </div>
          );

          // Allow custom rendering for special cases (e.g., inline editing)
          if (renderMobileCard) {
            return (
              <div key={row.id}>{renderMobileCard(row, defaultContent)}</div>
            );
          }

          // Default MobileCard with optional selection and actions
          return (
            <MobileCard
              key={row.id}
              selectable={
                isSelectable
                  ? {
                      isSelected: row.getIsSelected(),
                      onSelectionChange: (checked) =>
                        row.toggleSelected(checked),
                    }
                  : undefined
              }
              actions={actionsContent}
              onClick={handleClick}
            >
              {defaultContent}
            </MobileCard>
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
