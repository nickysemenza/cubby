import type { Icon } from "@phosphor-icons/react/lib";
import type { ReactNode } from "react";

import type { ListQueryPlan } from "~/app/_components/hooks/usePaginatedTableCore";

interface EntityRoutes {
  detail: string;
  list: string;
  create?: "dialog" | "page";
  new?: string;
}

interface EntityListConfig {
  hasUnitMappings?: boolean;
}

export interface EntityColor {
  accent: string;
  bg: string;
  text: string;
  border: string;
}

/**
 * Drives `EntityMergeDialog`. "ranked": the caller already picked the merge
 * set and its first row is the deterministic default keeper, with a picker for
 * an intentional override. "fixed": the record being viewed stays keeper;
 * the dialog fetches other same-type rows via `candidateQuery` to fold in.
 *
 * The registry stores heterogeneous merge definitions. `defineMergeableConfig`
 * preserves each owner's row/candidate correlation, validates its narrow row
 * contract at this dynamic registry seam, then exposes this common dialog port.
 */
export interface MergeDisplayRow {
  id: string;
}

interface MergeableConfigInput<TRow extends MergeDisplayRow> {
  keeperMode: "ranked" | "fixed";
  rowLabel: (row: TRow) => ReactNode;
  /** Secondary stat/chip line. */
  rowStat?: (row: TRow) => ReactNode;
  /** Fixed mode only: query options for the other rows a keeper can absorb. */
  candidateQuery?: (keeper: TRow) => ListQueryPlan<TRow>;
  copy: {
    /** Fixed mode gets the keeper's rendered label; ranked mode's is static. */
    title: string | ((keeperLabel: ReactNode) => ReactNode);
    description?: ReactNode | ((keeperLabel: ReactNode) => ReactNode);
    emptyTitle?: string;
    emptyDescription?: string;
    /** Standing policy note under the candidate list, regardless of selection. */
    caution?: ReactNode;
  };
}

export interface MergeableConfig {
  keeperMode: "ranked" | "fixed";
  rowLabel: (row: MergeDisplayRow) => ReactNode;
  rowStat?: (row: MergeDisplayRow) => ReactNode;
  candidateQuery?: (keeper: MergeDisplayRow) => ListQueryPlan<MergeDisplayRow>;
  copy: MergeableConfigInput<MergeDisplayRow>["copy"];
}

interface MergeableConfigDefinition<
  TRow extends MergeDisplayRow,
> extends MergeableConfigInput<TRow> {
  isRow: (row: MergeDisplayRow) => row is TRow;
}

/**
 * Adapt one entity-owned merge contract to the heterogeneous browser registry.
 *
 * The guard is a live contract: it prevents a caller from rendering a Product
 * with a Purchase formatter, and validates candidate rows before they reach
 * the shared dialog. No erased callback is invoked without first restoring its
 * owner row type.
 */
export function defineMergeableConfig<TRow extends MergeDisplayRow>(
  definition: MergeableConfigDefinition<TRow>,
): MergeableConfig {
  const requireOwnerRow = (row: MergeDisplayRow): TRow => {
    if (!definition.isRow(row)) {
      throw new Error("Merge configuration received a row from another entity");
    }
    return row;
  };

  return {
    keeperMode: definition.keeperMode,
    rowLabel: (row) => definition.rowLabel(requireOwnerRow(row)),
    rowStat: definition.rowStat
      ? (row) => definition.rowStat?.(requireOwnerRow(row))
      : undefined,
    candidateQuery: definition.candidateQuery
      ? (keeper) => {
          const plan = definition.candidateQuery?.(requireOwnerRow(keeper));
          if (!plan) {
            throw new Error("Merge configuration did not provide candidates");
          }
          return {
            ...plan,
            execute: async (context) => {
              const page = await plan.execute(context);
              const items: MergeDisplayRow[] = [];
              for (const row of page.items) items.push(requireOwnerRow(row));
              return { ...page, items };
            },
          };
        }
      : undefined,
    copy: definition.copy,
  };
}

export interface EntityDefinition {
  label: string;
  basePath: string;
  pluralLabel: string;
  phosphorIcon: Icon;
  color: EntityColor;
  routes: EntityRoutes;
  list?: EntityListConfig;
  mergeable?: MergeableConfig;
}
