"use client";

import type { LocationId } from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { buildLocationComboboxItem } from "../combobox/combobox-builders";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import { EntityInlineLink } from "../EntityInlineLink";
import { EntityInlineLinkList } from "../EntityInlineLinkList";
import { tryFormatAmount } from "../inventory/format-amount";
import { TruncatedList } from "../TruncatedList";
import type { CellClipboardSpec } from "./cell-clipboard";
import { EditableEntityCell } from "./editable-entity-cell";
import {
  entityCellClipboard,
  type InventoryEntryBase,
  type InventoryRelatedEntity,
} from "./inventory-column-helpers";

/** A single (transient, structurally-cast) location shape read off a row's
 * related-entity accessor — {@link InventoryEntryBase}'s `location` field is
 * intentionally loose (plain `string` id) so it also fits `product` rows;
 * the branded-id cast happens once here at the inline-edit boundary. */
type LocationLike = { id: LocationId; name: string; type: LocationType };

interface InventoryEntriesInlineEditConfig<T, TEntry> {
  /** WithLocationSearch — injected so unit tests can stub it. */
  SearchProvider: (props: WithEntitySearchProps<LocationId>) => ReactNode;
  onMoveEntry: (entry: TEntry, locationId: LocationId) => Promise<void>;
  onCreateEntry: (row: T, locationId: LocationId) => Promise<void>;
}

export interface InventoryEntriesCellProps<
  T,
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
> {
  entries: TEntry[];
  entity: TEntity;
  getRelatedEntity: (
    entry: TEntry,
  ) => Extract<InventoryRelatedEntity, { entity: TEntity }>["data"] | undefined;
  layout: "stacked" | "inline";
  row: T;
  onQuickEdit?: (row: T) => void;
  /** Only meaningful for entity === "location" + layout === "inline" — the
   * factory only ever passes this through under those conditions. */
  inlineEdit?: InventoryEntriesInlineEditConfig<T, TEntry>;
}

/**
 * Cell body for `createInventoryEntriesColumn` (extracted so the
 * entity==="location" + layout==="inline" path can use hooks): 0/1-entry rows
 * get an `EditableEntityCell` in pencil mode (inline edit + clipboard) when
 * `inlineEdit` is supplied; >1-entry rows and the "stacked" layout are
 * unchanged from the original inline cell body.
 */
export function InventoryEntriesCell<
  T,
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
>({
  entries,
  entity,
  getRelatedEntity,
  layout,
  row,
  onQuickEdit,
  inlineEdit,
}: InventoryEntriesCellProps<T, TEntry, TEntity>) {
  const renderEntry = (entry: TEntry) => {
    const related = getRelatedEntity(entry);
    if (!related) return null;
    return (
      <span key={entry.id} className="inline-flex items-center gap-1">
        <span className="text-muted-foreground">
          {tryFormatAmount(entry.amount)}
        </span>
        <span className="text-muted-foreground/50">@</span>
        <EntityInlineLink entity={entity} data={related as never} compact />
      </span>
    );
  };

  if (entries.length === 0) {
    if (inlineEdit) {
      const clipboard: CellClipboardSpec = {
        kindKey: "entity:location",
        // Copy disabled (no getCopyPayload) — nothing to copy from an empty cell.
        onPasteValue: async ({ json }) => {
          const pasted = json as { id?: unknown; name?: unknown } | undefined;
          if (
            !pasted ||
            typeof pasted.id !== "string" ||
            typeof pasted.name !== "string"
          ) {
            throw new Error("Paste a location cell here");
          }
          await inlineEdit.onCreateEntry(row, pasted.id as LocationId);
          return { id: pasted.id, name: pasted.name };
        },
      };
      return (
        <EditableEntityCell
          value={null}
          label="location"
          trigger="pencil"
          SearchProvider={inlineEdit.SearchProvider}
          onSave={async (locationId) => {
            if (locationId) await inlineEdit.onCreateEntry(row, locationId);
          }}
          clipboard={clipboard}
          renderValue={() => <NoneValue />}
        />
      );
    }
    return <NoneValue />;
  }

  const quickEditButton = onQuickEdit ? (
    <Button
      size="icon"
      variant="ghost"
      className="h-5 w-5 shrink-0 opacity-40 pointer-coarse:opacity-100 transition-opacity focus-visible:opacity-100 group-hover/quickedit:opacity-100"
      aria-label="Quick edit"
      onClick={(e) => {
        e.stopPropagation();
        onQuickEdit(row);
      }}
    >
      <Pencil className="h-3 w-3 text-muted-foreground" />
    </Button>
  ) : null;

  if (layout === "inline") {
    if (inlineEdit && entries.length === 1) {
      const entry = entries[0]!;
      const related = getRelatedEntity(entry) as unknown as
        | LocationLike
        | undefined;
      const current = related ? buildLocationComboboxItem(related) : null;

      return (
        <EditableEntityCell
          value={current}
          label="location"
          trigger="pencil"
          SearchProvider={inlineEdit.SearchProvider}
          onSave={async (locationId) => {
            if (locationId) await inlineEdit.onMoveEntry(entry, locationId);
          }}
          clipboard={entityCellClipboard("location", current, (id) =>
            inlineEdit.onMoveEntry(entry, id),
          )}
          renderValue={(v) => {
            if (!v) return <NoneValue />;
            // Keep the real inline link while the display matches the row
            // data; a transient optimistic value (different id, or only
            // {id,name} known from a paste) renders as plain text until the
            // invalidated query restores the location summary.
            const linkData = related && v.id === related.id ? related : null;
            return (
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">
                  {tryFormatAmount(entry.amount)}
                </span>
                <span className="text-muted-foreground/50">@</span>
                {linkData ? (
                  <EntityInlineLink entity="location" data={linkData} compact />
                ) : (
                  <span className="truncate">{v.name}</span>
                )}
              </span>
            );
          }}
        />
      );
    }

    const list = (
      <TruncatedList
        items={entries}
        maxItems={1}
        gap="gap-1"
        className="min-w-0 flex-1"
        renderItem={(entry) => renderEntry(entry)}
        renderOverflowItem={(entry) => renderEntry(entry)}
      />
    );

    if (!quickEditButton) return list;
    return (
      <Row align="center" gap="xs" className="group/quickedit min-w-0">
        {list}
        {quickEditButton}
      </Row>
    );
  }

  // Stacked layout: amounts grouped, then pills grouped
  const relatedEntities = entries
    .map((entry) => getRelatedEntity(entry) as never)
    .filter(Boolean);
  return (
    <Stack gap="tight">
      <Stack gap="tight" className="text-xs">
        {entries.map((entry) => (
          <div key={entry.id}>{tryFormatAmount(entry.amount)}</div>
        ))}
      </Stack>
      <EntityInlineLinkList
        entity={entity}
        items={relatedEntities as never}
        compact
      />
    </Stack>
  );
}
