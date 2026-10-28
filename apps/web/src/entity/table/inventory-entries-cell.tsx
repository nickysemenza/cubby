import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { type LocationShortcode } from "@cubby/schemas/identifiers";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  EntityRefLink,
  EntityRefList,
} from "~/entity/components/entity-ref-link";
import { useEntityMetadata } from "~/entity/metadata";
import { useDenseCell } from "~/ui/common/stacked-value";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { NoneValue } from "~/ui/primitives/none-value";

import {
  CELL_EDIT_GROUP_CLASS,
  CELL_EDIT_PENCIL_CLASS,
} from "../../ui/data-table/cell-frame";
import {
  entityCellClipboard,
  type InventoryEntryBase,
  type InventoryRelatedEntity,
} from "../../ui/data-table/inventory-column-helpers";
import { tryFormatAmount } from "../../ui/text/format-amount";
import { TruncatedList } from "../../ui/truncated-list";
import {
  entityDisplayImageKey,
  useEntityDisplayImageMap,
} from "../entity-media/entity-display-images";
import { buildRecordComboboxItem } from "../picker/combobox-builders";
import type { SearchProviderProps } from "../picker/with-search-hook";
import { EditableEntityCell } from "./editable-entity-cell";

interface InventoryEntriesInlineEditConfig<T, TEntry> {
  /** WithLocationSearch — injected so unit tests can stub it. */
  SearchProvider: (props: SearchProviderProps<LocationShortcode>) => ReactNode;
  onMoveEntry: (entry: TEntry, locationId: LocationShortcode) => Promise<void>;
  onCreateEntry: (row: T, locationId: LocationShortcode) => Promise<void>;
}

export interface InventoryEntriesCellProps<
  T,
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
> {
  entries: TEntry[];
  context?: string | null;
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

function amountLabel(entry: InventoryEntryBase): string {
  const amount = fieldValueOf(entry.fields.amount);
  return amount ? tryFormatAmount(amount) : "";
}

/**
 * Cell body for `createInventoryEntriesColumn` (extracted so the
 * entity==="location" + layout==="inline" path can use hooks): 0/1-entry rows
 * get an `EditableEntityCell` in pencil mode (inline edit + clipboard) when
 * `inlineEdit` is supplied; >1-entry rows and the "stacked" layout are
 * unchanged from the original inline cell body.
 */
function InventoryEntriesCellBody<
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
  context,
}: InventoryEntriesCellProps<T, TEntry, TEntity>) {
  const queryClient = useQueryClient();
  useEntityMetadata("location");
  const displayImages = useEntityDisplayImageMap();
  // A dense cell stacks the amount under the name instead of "1 each @".
  const dense = useDenseCell();

  const renderRelatedEntity = (
    related: InventoryRelatedEntity["data"],
    context?: string,
  ) => {
    const displayImage =
      displayImages[
        entityDisplayImageKey({ entityKind: entity, entityId: related.id })
      ] ?? null;
    if (entity === "location") {
      return (
        <EntityRefLink
          displayImage={displayImage}
          entity="location"
          data={related}
          context={context}
        />
      );
    }
    if (entity === "product") {
      return (
        <EntityRefLink
          displayImage={displayImage}
          entity="product"
          data={related}
          context={context}
        />
      );
    }
    throw new Error(`Unexpected ${entity} inventory relation`);
  };

  const renderEntry = (entry: TEntry) => {
    const related = getRelatedEntity(entry);
    if (!related) return null;
    if (dense)
      return (
        <span key={entry.id} className="flex min-w-0">
          {renderRelatedEntity(related, amountLabel(entry))}
        </span>
      );
    return (
      <span key={entry.id} className="inline-flex items-center gap-1">
        <span className="text-muted-foreground">
          <FieldRecordValue record={entry} field="amount">
            {amountLabel(entry) || <NoneValue />}
          </FieldRecordValue>
        </span>
        <span className="text-muted-foreground/50">@</span>
        {renderRelatedEntity(related)}
      </span>
    );
  };

  if (entries.length === 0) {
    if (inlineEdit) {
      return (
        <EditableEntityCell
          value={null}
          label="location"
          trigger="pencil"
          SearchProvider={inlineEdit.SearchProvider}
          onSave={async (locationId) => {
            if (locationId) await inlineEdit.onCreateEntry(row, locationId);
          }}
          clipboard={entityCellClipboard("location", null, (locationId) =>
            inlineEdit.onCreateEntry(row, locationId),
          )}
          renderValue={() => context ?? <NoneValue />}
        />
      );
    }
    return <>{context ?? <NoneValue />}</>;
  }

  const quickEditButton = onQuickEdit ? (
    <Button
      size="icon"
      variant="ghost"
      className={CELL_EDIT_PENCIL_CLASS}
      aria-label="Quick edit"
      onClick={(e) => {
        e.stopPropagation();
        onQuickEdit(row);
      }}
    >
      <PencilIcon className="size-3 text-muted-foreground" />
    </Button>
  ) : null;

  if (layout === "inline") {
    if (inlineEdit && entries.length === 1) {
      const entry = entries[0]!;
      const related = getRelatedEntity(entry);
      const current = related
        ? buildRecordComboboxItem(queryClient, "location", related)
        : null;

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
            if (dense && linkData)
              return (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <EntityRefLink
                    displayImage={
                      displayImages[
                        entityDisplayImageKey({
                          entityKind: "location",
                          entityId: linkData.id,
                        })
                      ] ?? null
                    }
                    entity="location"
                    data={linkData}
                    context={amountLabel(entry) || undefined}
                  />
                  <FieldRecordValue record={entry} field="amount">
                    {null}
                  </FieldRecordValue>
                </span>
              );
            return (
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground">
                  <FieldRecordValue record={entry} field="amount">
                    {amountLabel(entry) || <NoneValue />}
                  </FieldRecordValue>
                </span>
                <span className="text-muted-foreground/50">@</span>
                {linkData ? (
                  <EntityRefLink
                    displayImage={
                      displayImages[
                        entityDisplayImageKey({
                          entityKind: "location",
                          entityId: linkData.id,
                        })
                      ] ?? null
                    }
                    entity="location"
                    data={linkData}
                  />
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
      <span className={CELL_EDIT_GROUP_CLASS}>
        {list}
        {quickEditButton}
      </span>
    );
  }

  // Stacked layout: amounts grouped, then pills grouped
  const relatedEntities: InventoryRelatedEntity["data"][] = entries.flatMap(
    (entry) => {
      const related = getRelatedEntity(entry);
      return related ? [related] : [];
    },
  );
  const relatedList = (() => {
    if (entity === "location") {
      const locations = relatedEntities;
      return (
        <EntityRefList
          entity="location"
          items={locations}
          compact
          resolveImages={false}
        />
      );
    }
    const products = relatedEntities;
    return (
      <EntityRefList
        entity="product"
        items={products}
        compact
        resolveImages={false}
      />
    );
  })();
  return (
    <Stack gap="tight">
      <Stack gap="tight" className="text-xs">
        {entries.map((entry) => (
          <div key={entry.id}>
            <FieldRecordValue record={entry} field="amount">
              {amountLabel(entry) || <NoneValue />}
            </FieldRecordValue>
          </div>
        ))}
      </Stack>
      {relatedList}
    </Stack>
  );
}

/** Context supplements the links and never replaces a recorded location. */
export function InventoryEntriesCell<
  T,
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
>(props: InventoryEntriesCellProps<T, TEntry, TEntity>) {
  const dense = useDenseCell();
  const supplementalContext = props.entries.length > 0 ? props.context : null;
  return (
    <div
      className="min-w-0"
      title={dense ? (supplementalContext ?? undefined) : undefined}
    >
      <InventoryEntriesCellBody {...props} />
      {supplementalContext ? (
        // The location and amount already occupy both lines of a dense row.
        <div
          className={
            dense ? "sr-only" : "truncate text-xs text-muted-foreground"
          }
        >
          {supplementalContext}
        </div>
      ) : null}
    </div>
  );
}
