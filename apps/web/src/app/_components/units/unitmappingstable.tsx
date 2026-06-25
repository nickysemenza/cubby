import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { Row } from "~/components/layout";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  BASE_KINDS,
  type BaseKind,
  conversionCoverage,
} from "~/lib/conversion-coverage";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import RTable from "../data-table/Table";
import { EntityPillLink } from "../EntityPill";
import { kindIconMap } from "./kind-icons";

const BASE_KIND_SET: ReadonlySet<string> = new Set(BASE_KINDS);

// The base measurement kind a unit belongs to, or null for nutrient:* / other:*
// units (which `kindIconMap` has no icon for). `amount_kind` is a cheap, cached
// WASM probe; it never throws today, but guard defensively.
const baseKindForUnit = (unit: string): BaseKind | null => {
  try {
    const k = wasm.amount_kind({ value: 1, unit });
    return BASE_KIND_SET.has(k) ? (k as BaseKind) : null;
  } catch {
    return null;
  }
};

// Leading per-row marker: the target amount's kind icon, lit when that big-4
// kind participates in a working conversion (ties each row to the coverage
// chips above). Nutrient/other rows get a muted dot so the column stays aligned.
const KindAccent: React.FC<{
  unit: string;
  covered: ReadonlySet<BaseKind>;
}> = ({ unit, covered }) => {
  const kind = baseKindForUnit(unit);
  if (!kind) {
    return (
      <span
        aria-hidden
        className="inline-block h-1 w-1 shrink-0 rounded-full bg-muted-foreground/30"
      />
    );
  }
  const { Icon, label } = kindIconMap[kind];
  const lit = covered.has(kind);
  const state = lit ? "convertible" : "no conversion";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <span className="sr-only">{`${label}: ${state}`}</span>
        <Icon
          className={`h-3.5 w-3.5 ${lit ? "text-foreground" : "text-muted-foreground/40"}`}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{`${label}: ${state}`}</TooltipContent>
    </Tooltip>
  );
};

// Component for lazy loading food data and rendering FoodPillLink
const LazyFoodPillLink: React.FC<{ fdcId: number }> = ({ fdcId }) => {
  const api = useTRPC();
  const { data: food, isLoading } = useQuery(
    api.usda.getByID.queryOptions(
      { id: fdcId },
      {
        // Cache for 5 minutes since food data doesn't change often
        staleTime: 5 * 60 * 1000,
      },
    ),
  );

  // Show placeholder while loading or if no data
  const displayFood = food || {
    fdc_id: fdcId,
    foodInfo: { description: `food ${fdcId}${isLoading ? "..." : ""}` },
  };

  return <EntityPillLink entity="usda-food" data={displayFood} compact />;
};

// Component for lazy loading product data and rendering ProductPillLink
const LazyProductPillLink: React.FC<{ productId: string }> = ({
  productId,
}) => {
  const api = useTRPC();
  const { data: product, isLoading } = useQuery(
    api.product.getByID.queryOptions(
      { id: productId },
      {
        // Cache for 5 minutes since product data doesn't change often
        staleTime: 5 * 60 * 1000,
      },
    ),
  );

  // Show placeholder while loading or if no data
  const displayProduct = product || {
    id: productId,
    name: `product ${productId.slice(0, 8)}${isLoading ? "..." : ""}`,
    manufacturer: "",
  };

  return <EntityPillLink entity="product" data={displayProduct} compact />;
};

// Source label + provenance pill, shared by the desktop cell and the mobile card.
const MappingSource: React.FC<{ mapping: UnitMapping }> = ({ mapping }) => {
  const { source, sourceMetadata } = mapping;
  if (!sourceMetadata) return <>{source || ""}</>;
  return (
    <Row as="span" align="center" gap="xs">
      <span>{source || ""}</span>
      {sourceMetadata.type === "food" && (
        <LazyFoodPillLink fdcId={sourceMetadata.fdcId} />
      )}
      {sourceMetadata.type === "product" && (
        <LazyProductPillLink productId={sourceMetadata.productId} />
      )}
    </Row>
  );
};

export const UnitMappingsTable: React.FC<{
  mappings: UnitMapping[];
  /** Must match the `kinds` passed to the sibling ConversionCapabilities so
   * row icons and coverage chips grade against the same kind universe. */
  kinds?: readonly BaseKind[];
}> = ({ mappings, kinds }) => {
  const columnHelper = createColumnHelper<UnitMapping>();

  // Same engine the coverage chips read, so a row's lit icon and the chip above
  // can't disagree. Cheap (6 cached probes), memoized per mapping set.
  const covered = useMemo(
    () => conversionCoverage(mappings, kinds).covered,
    [mappings, kinds],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => wasm.format_amount(row.a), {
        id: "from",
        header: "From",
        enableSorting: false,
        // The table uses table-layout:fixed, so give From/To explicit widths sized
        // to their short content; the unspecified Source column then claims the rest.
        meta: { className: "w-16 whitespace-nowrap p-0.5" /* tight */ },
      }),
      columnHelper.accessor((row) => wasm.format_amount(row.b), {
        id: "to",
        header: "To",
        enableSorting: false,
        meta: { className: "w-32 whitespace-nowrap p-0.5" /* tight */ },
        cell: (info) => (
          <Row as="span" align="center" gap="xs" className="whitespace-nowrap">
            <KindAccent unit={info.row.original.b.unit} covered={covered} />
            <span>{info.getValue()}</span>
          </Row>
        ),
      }),
      columnHelper.accessor("source", {
        id: "source",
        header: "Source",
        enableSorting: false,
        // Unspecified width: in table-layout:fixed this column absorbs the
        // remaining space; truncate ellipsizes the long source label/pill.
        meta: { className: "truncate p-0.5" /* tight */ },
        cell: (info) => <MappingSource mapping={info.row.original} />,
      }),
    ],
    [columnHelper, covered],
  );

  const table = useReactTable({
    data: mappings,
    columns,
    enableSorting: false,
    enableFilters: false,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row, i) => `${i}-${row.source}`,
  });

  // A mapping row has no entity name, so the generic mobile card derives a
  // "Unknown" title. Render the conversion itself instead: "from = to · source".
  return (
    <RTable
      table={table}
      renderMobileCard={(row) => {
        const m = row.original;
        return (
          <Row
            align="center"
            justify="between"
            gap="sm"
            className="border-b px-1 py-2 text-sm"
          >
            <Row
              as="span"
              align="center"
              gap="xs"
              className="whitespace-nowrap font-medium"
            >
              <span>{wasm.format_amount(m.a)} =</span>
              <KindAccent unit={m.b.unit} covered={covered} />
              <span>{wasm.format_amount(m.b)}</span>
            </Row>
            <Row
              as="span"
              align="center"
              gap="xs"
              className="min-w-0 truncate text-muted-foreground text-xs"
            >
              <MappingSource mapping={m} />
            </Row>
          </Row>
        );
      }}
    />
  );
};
