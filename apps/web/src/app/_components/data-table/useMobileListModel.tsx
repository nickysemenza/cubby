import type { Entity } from "@cubby/schemas/entity";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { isValidElement, type ReactNode, useMemo } from "react";
import { NoneValue } from "~/components/ui/none-value";
import { entities } from "~/entities/entities";
import { extractEntityTitle } from "~/lib/entity-utils";
import type { MobileColumnMeta, MobileSlot } from "./columnHelpers";

const DEFAULT_HIDDEN_COLUMN_IDS = new Set([
  "createdAt",
  "notes",
  "model",
  "fdc_id",
  "unitMapping",
  "unitMappings",
  "inventoryEntry",
  "inventoryEntries",
  "food",
  "nutrition",
  "meta",
]);

interface MobileCellMeta {
  mobile?: MobileColumnMeta;
}

interface SlotValue {
  priority: number;
  value: ReactNode;
  /** See `MobileColumnMeta.interactive`. */
  interactive?: boolean;
}

interface MobileListRowModel<TItem> {
  row: Row<TItem>;
  title: string;
  subtitle?: ReactNode;
  imageSlot?: ReactNode;
  actionsContent?: ReactNode;
  rightValues: ReactNode[];
  /**
   * Parallel array to `rightValues` — `rightValueInteractive[i]` is true when
   * `rightValues[i]`'s source column set `meta.mobile.interactive`.
   */
  rightValueInteractive: boolean[];
  detailsHref?: string;
}

function hasRenderableContent(content: ReactNode): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed !== "" && trimmed !== "—";
  }
  if (isValidElement(content) && content.type === NoneValue) return false;
  return true;
}

function resolveSlot(colId: string, meta?: MobileCellMeta): MobileSlot {
  if (meta?.mobile?.slot) return meta.mobile.slot;
  if (DEFAULT_HIDDEN_COLUMN_IDS.has(colId)) return "hidden";
  if (colId === "image") return "image";
  if (colId === "actions") return "actions";
  if (colId === "name" || colId === "filename") return "title";

  return "meta";
}

function getPriority(
  meta: MobileCellMeta | undefined,
  fallback: number,
): number {
  return meta?.mobile?.priority ?? fallback;
}

export function useMobileListModel<TItem>({
  table,
  entity,
  maxRightValues = 2,
}: {
  table: ITable<TItem>;
  entity?: Entity;
  maxRightValues?: number;
}): MobileListRowModel<TItem>[] {
  const rows = table.getRowModel().rows;
  const basePath = entity ? entities[entity].basePath : undefined;

  return useMemo(
    () =>
      rows.map((row) => {
        let title = extractEntityTitle(row.original);
        // Mobile: drop the redundant " @ Location" suffix — the location is
        // already rendered as the row subtitle, and the suffix forces the
        // product name to truncate mid-word.
        if (entity === "inventory") {
          const product = (row.original as { product?: { name?: string } })
            .product;
          if (product?.name) title = product.name;
        }
        let imageSlot: ReactNode | undefined;
        let actionsContent: ReactNode | undefined;
        const subtitleCandidates: SlotValue[] = [];
        const trailingValues: SlotValue[] = [];
        const metaValues: SlotValue[] = [];

        for (const cell of row.getVisibleCells()) {
          const colId = cell.column.id;
          if (colId === "select") continue;

          const meta = cell.column.columnDef.meta as MobileCellMeta | undefined;
          const slot = resolveSlot(colId, meta);
          if (slot === "hidden") continue;

          // Skip empty raw values quickly to avoid rendering inert wrappers.
          // Only applies to accessor columns — `columnHelper.display()`
          // columns (the actions menu, the USDA-food cell) have no
          // accessorFn, so `getValue()` always resolves undefined and would
          // otherwise get skipped unconditionally, before ever rendering.
          // Those fall through to the post-render `hasRenderableContent`
          // check instead.
          if (cell.column.accessorFn) {
            const rawValue = cell.getValue();
            if (
              rawValue === null ||
              rawValue === undefined ||
              rawValue === "" ||
              (Array.isArray(rawValue) && rawValue.length === 0)
            ) {
              continue;
            }
          }

          const rendered = flexRender(
            cell.column.columnDef.cell,
            cell.getContext(),
          );
          if (!hasRenderableContent(rendered)) continue;

          if (slot === "actions") {
            actionsContent = rendered;
            continue;
          }
          if (slot === "image") {
            imageSlot = rendered;
            continue;
          }
          if (slot === "title") {
            if (typeof rendered === "string" && rendered.trim().length > 0) {
              title = rendered;
            }
            continue;
          }

          const priority = getPriority(meta, 50);
          const interactive = meta?.mobile?.interactive;
          if (slot === "subtitle") {
            subtitleCandidates.push({ priority, value: rendered });
            continue;
          }
          if (slot === "trailing") {
            trailingValues.push({ priority, value: rendered, interactive });
            continue;
          }
          metaValues.push({ priority, value: rendered, interactive });
        }

        subtitleCandidates.sort((a, b) => a.priority - b.priority);
        trailingValues.sort((a, b) => a.priority - b.priority);
        metaValues.sort((a, b) => a.priority - b.priority);

        const subtitle = subtitleCandidates[0]?.value;
        const rightValueSlots = [...trailingValues, ...metaValues].slice(
          0,
          maxRightValues,
        );
        const rightValues = rightValueSlots.map((item) => item.value);
        const rightValueInteractive = rightValueSlots.map(
          (item) => !!item.interactive,
        );

        const rowData = row.original as Record<string, unknown>;
        const entityId = rowData.id as string | undefined;
        const detailsHref =
          basePath && entityId ? `/${basePath}/${entityId}` : undefined;

        return {
          row,
          title,
          subtitle,
          imageSlot,
          actionsContent,
          rightValues,
          rightValueInteractive,
          detailsHref,
        };
      }),
    [basePath, entity, maxRightValues, rows],
  );
}
