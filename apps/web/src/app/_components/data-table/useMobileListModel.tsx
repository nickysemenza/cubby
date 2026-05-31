import type { Entity } from "@cubby/schemas/entity";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { isValidElement, type ReactNode, useMemo } from "react";
import { entities } from "~/entities/entities";
import { extractEntityTitle } from "~/lib/entity-utils";
import { NoneState } from "../NoneState";
import type { MobileColumnMeta, MobileSlot } from "./columnHelpers";

const DEFAULT_HIDDEN_COLUMN_IDS = new Set([
  "createdAt",
  "notes",
  "ndb_number",
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
  mobileCategory?: "hero" | "compact" | "medium" | "wide";
  mobileHidden?: boolean;
}

interface SlotValue {
  priority: number;
  value: ReactNode;
}

interface MobileListRowModel<TItem> {
  row: Row<TItem>;
  title: string;
  subtitle?: ReactNode;
  imageSlot?: ReactNode;
  actionsContent?: ReactNode;
  rightValues: ReactNode[];
  detailsHref?: string;
}

function hasRenderableContent(content: ReactNode): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed !== "" && trimmed !== "—";
  }
  if (isValidElement(content) && content.type === NoneState) return false;
  return true;
}

function resolveSlot(colId: string, meta?: MobileCellMeta): MobileSlot {
  if (meta?.mobileHidden) return "hidden";
  if (meta?.mobile?.slot) return meta.mobile.slot;
  if (DEFAULT_HIDDEN_COLUMN_IDS.has(colId)) return "hidden";
  if (colId === "image") return "image";
  if (colId === "actions") return "actions";
  if (colId === "name" || colId === "filename") return "title";

  if (meta?.mobileCategory === "compact" || meta?.mobileCategory === "medium") {
    return "subtitle";
  }
  if (meta?.mobileCategory === "wide" || meta?.mobileCategory === "hero") {
    return "meta";
  }
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
          const rawValue = cell.getValue();
          if (
            rawValue === null ||
            rawValue === undefined ||
            rawValue === "" ||
            (Array.isArray(rawValue) && rawValue.length === 0)
          ) {
            continue;
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
          if (slot === "subtitle") {
            subtitleCandidates.push({ priority, value: rendered });
            continue;
          }
          if (slot === "trailing") {
            trailingValues.push({ priority, value: rendered });
            continue;
          }
          metaValues.push({ priority, value: rendered });
        }

        subtitleCandidates.sort((a, b) => a.priority - b.priority);
        trailingValues.sort((a, b) => a.priority - b.priority);
        metaValues.sort((a, b) => a.priority - b.priority);

        const subtitle = subtitleCandidates[0]?.value;
        const rightValues = [...trailingValues, ...metaValues]
          .map((item) => item.value)
          .slice(0, maxRightValues);

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
          detailsHref,
        };
      }),
    [basePath, maxRightValues, rows],
  );
}
