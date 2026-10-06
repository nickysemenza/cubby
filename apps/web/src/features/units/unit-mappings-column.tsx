import { type BaseKind, gradedKinds } from "~/lib/conversion-coverage";
import type { CubbyColumnHelper as ColumnHelper } from "~/ui/data-table/table-features";

import { UnitMappingDisplay } from "./UnitMappingDisplay";

type UnitMapping = Parameters<typeof UnitMappingDisplay>[0]["mappings"][number];

export function createUnitMappingsColumn<
  // `ingredient.naKinds` is the coverage opt-out; optional so the ingredient
  // list (whose rows ARE the ingredient) and any future caller still fit.
  T extends { id: string; ingredient?: { naKinds?: BaseKind[] | null } | null },
>(
  columnHelper: ColumnHelper<T>,
  /** A lookup, so callers keep the column stable while their map grows. */
  mappingsFor: (id: string) => UnitMapping[] | undefined,
  options?: {
    id?: string;
    header?: string;
    className?: string;
    enableSorting?: boolean;
    compact?: boolean;
  },
) {
  const compact = options?.compact ?? true;
  return columnHelper.display({
    id: options?.id ?? "unitMappings",
    header: options?.header ?? "Unit Mappings",
    enableSorting: options?.enableSorting ?? false,
    meta: {
      className:
        options?.className ?? (compact ? "min-w-0 w-32" : "w-96 max-w-96"),
    },
    cell: (info) => {
      const entity = info.row.original;
      const mappings = mappingsFor(entity.id) ?? [];
      return (
        <div className="w-full">
          <UnitMappingDisplay
            mappings={mappings}
            title=""
            compact={compact}
            showTier={compact}
            // Grade against the linked ingredient's applicable kinds, same as
            // the Problems panel and the enrichment workbench. Without this the
            // list graded against all four BASE_KINDS and disagreed with both —
            // an ingredient that opted out of `volume` read worse here than on
            // the page you'd go to act on it.
            kinds={gradedKinds(entity.ingredient?.naKinds)}
          />
        </div>
      );
    },
  });
}
