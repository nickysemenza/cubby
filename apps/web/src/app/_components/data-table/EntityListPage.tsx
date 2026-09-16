import type { ReactNode } from "react";

import { usePageCount } from "~/components/page/Page";
import { entities } from "~/entities/entities";

import {
  type BaseListRow,
  type UseEntityListOptions,
  type UseEntityListReturn,
  useEntityList,
} from "../hooks/useEntityList";
import {
  type EntityPreviewRowData,
  type PreviewIdField,
  useEntityPreview,
} from "../hooks/useEntityPreview";
import { ListWorkbench, type ListWorkbenchProps } from "./ListWorkbench";

/** The `ListWorkbench` props a page still gets to decide for itself. */
type WorkbenchProps<TData extends BaseListRow> = Pick<
  ListWorkbenchProps<TData>,
  | "actions"
  | "ariaLabel"
  | "contextualStatus"
  | "emptyState"
  | "getRowClassName"
  | "inspectorToggle"
  | "onRowClick"
  | "onRowHover"
  | "onRowHoverEnd"
  | "showCellSelectionStats"
  | "verticalAlign"
>;

export type EntityListPreview = false | { idField?: PreviewIdField };

export function entityListPreviewOptions(
  preview: EntityListPreview | undefined,
) {
  return preview === false
    ? undefined
    : { idField: preview?.idField, responsiveInspector: true };
}

export interface EntityListPageProps<
  TData extends BaseListRow & EntityPreviewRowData,
  TFilters extends object,
>
  extends
    Omit<UseEntityListOptions<TData, TFilters, TData>, "preview" | "tree">,
    WorkbenchProps<TData> {
  /**
   * Row-preview sheet. Defaults to the entity's own preview keyed on `id`;
   * pass `{ idField }` for a list whose row id lives elsewhere (USDA's
   * `fdc_id`), or `false` for a list that must not open one.
   */
  preview?: EntityListPreview;
  /**
   * Dialogs and other page-level chrome rendered under the table.
   *
   * The function form receives the list model, for the one thing a sibling
   * dialog routinely needs and cannot get from props: `workbench.table`, to
   * clear the row selection once a bulk write finishes. It is NOT a general
   * escape hatch — a page that has to reshape the table itself, or read `data`
   * to build content ABOVE it, calls `useEntityList` directly.
   */
  children?:
    | ReactNode
    | ((list: UseEntityListReturn<TData, TFilters, TData>) => ReactNode);
}

function isListChromeRenderer<
  TData extends BaseListRow & EntityPreviewRowData,
  TFilters extends object,
>(
  children: EntityListPageProps<TData, TFilters>["children"],
): children is (
  list: UseEntityListReturn<TData, TFilters, TData>,
) => ReactNode {
  return typeof children === "function";
}

/**
 * A top-level entity list page: the table, its preview sheet, and the page's
 * record count, wired the one way every list page wires them.
 *
 * Everything a page still decides — its columns, its toolbar actions, its
 * genuine quirks — stays a prop and is forwarded VERBATIM. That matters:
 * `columns` memos downstream depend on the referential stability of
 * `namePrefix` / `nameEditable` / `filterOptions`, so this component must never
 * rewrap them (see the module-level-constant notes on those call sites).
 *
 * A page that needs the hook's RETURN to build its own layout (`data` for a card
 * or shelf view, `currentFilters` for a second aggregate query, stat tiles above
 * the table) calls `useEntityList` directly instead. `children` may take the
 * model as an argument, but only for chrome rendered UNDER the table.
 */
export function EntityListPage<
  TData extends BaseListRow & EntityPreviewRowData,
  TFilters extends object = object,
>({
  actions,
  ariaLabel,
  contextualStatus,
  emptyState,
  getRowClassName,
  onRowClick,
  onRowHover,
  onRowHoverEnd,
  showCellSelectionStats,
  verticalAlign,
  preview,
  children,
  ...listOptions
}: EntityListPageProps<TData, TFilters>) {
  const { entity } = listOptions;
  const {
    onRowClick: previewClick,
    inspectRow,
    onRowHover: previewHover,
    onRowHoverEnd: previewHoverEnd,
    PreviewSheet,
    preview: currentPreview,
    dockedInspector,
    inspectorToggle,
  } = useEntityPreview(entity, entityListPreviewOptions(preview));
  const rowClick = preview === false ? undefined : previewClick;
  const rowHover = preview === false ? undefined : previewHover;
  const rowHoverEnd = preview === false ? undefined : previewHoverEnd;

  // `deletable` defaults ON here, unlike the hook: a top-level list page owns
  // its entity's rows, where an embedded relationship ledger does not.
  const list = useEntityList<TData, TFilters>({
    deletable: true,
    ...listOptions,
    onInspectRow: preview === false ? undefined : inspectRow,
  });
  usePageCount(list.totalCount);

  return (
    <div>
      <ListWorkbench
        model={list.workbench}
        ariaLabel={ariaLabel ?? `${entities[entity].pluralLabel} table`}
        actions={actions}
        contextualStatus={contextualStatus}
        emptyState={emptyState}
        getRowClassName={getRowClassName}
        showCellSelectionStats={showCellSelectionStats}
        verticalAlign={verticalAlign}
        currentRowId={currentPreview?.rowKey}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
        onRowClick={onRowClick ?? rowClick}
        onRowHover={onRowHover ?? rowHover}
        onRowHoverEnd={onRowHoverEnd ?? rowHoverEnd}
      />
      {isListChromeRenderer(children) ? children(list) : children}
      {preview === false ? null : <PreviewSheet />}
    </div>
  );
}
