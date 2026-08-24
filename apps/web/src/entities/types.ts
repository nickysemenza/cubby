import type {
  MergeCandidate,
  PreviewMergeEntity,
} from "@cubby/schemas/entity-integrity";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EntityRoutes {
  detail: string;
  list: string;
  new?: string;
}

type CommonSectionType = "images" | "history" | "unit-mappings";

type StandardColumnType = "image" | "name";

interface EntityDetailConfig {
  commonSections?: CommonSectionType[];
}

interface EntityListConfig {
  hasUnitMappings?: boolean;
  defaultSort?: string;
  /**
   * Direction the list opens `defaultSort` in. Defaults to "desc", which is
   * right for the date/amount columns most lists open on and WRONG for a name
   * roster — that is the whole reason this field exists, since `useTableState`
   * would otherwise open every name-sorted list Z→A.
   */
  defaultSortDirection?: "asc" | "desc";
  standardColumns?: StandardColumnType[];
}

export interface EntityColor {
  accent: string;
  bg: string;
  text: string;
  border: string;
}

/**
 * Drives `EntityMergeDialog`. "ranked": the caller already picked the merge
 * set (bulk-selection, an AI-suggested pair); the dialog ranks it via
 * `previewOperation`'s no-`keepId` call and defaults to the best-weighted row,
 * picker overridable. "fixed": one row is already the keeper (the record
 * being viewed); the dialog fetches other same-type rows via `candidateQuery`
 * to fold in, no picker.
 *
 * Row/candidate types are `any` on purpose — heterogeneous across entities by
 * design, and every real caller already has a fully-typed row.
 */
export interface MergeableConfig {
  keeperMode: "ranked" | "fixed";
  /** `previewOperation`'s entity key, only when it differs from the registry key. */
  previewEntity?: PreviewMergeEntity;
  /** Primary row line. Ranked mode also gets the ranking preview's candidate
   * detail once loaded (e.g. a USDA-link badge riding the name). */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous row shape, see doc comment above.
  rowLabel: (row: any, candidate?: MergeCandidate) => ReactNode;
  /** Secondary stat/chip line. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous row shape, see doc comment above.
  rowStat?: (row: any, candidate?: MergeCandidate) => ReactNode;
  /** Fixed mode only: query options for the other rows a keeper can absorb. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous row/query shape, see doc comment above.
  candidateQuery?: (api: any, keeper: any) => any;
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

export interface EntityDefinition {
  label: string;
  basePath: string;
  pluralLabel: string;
  lucideIcon: LucideIcon;
  color: EntityColor;
  routes: EntityRoutes;
  /**
   * Dependency-free client projection of the server sort contracts. Route
   * loaders only need these field names; importing every entity schema here
   * would pull validation graphs into the eager route tree, so the arrays stay
   * hand-listed and a drift test pins them to the canonical schema exports.
   */
  sortableFields: readonly string[];
  detail?: EntityDetailConfig;
  list?: EntityListConfig;
  mergeable?: MergeableConfig;
}
