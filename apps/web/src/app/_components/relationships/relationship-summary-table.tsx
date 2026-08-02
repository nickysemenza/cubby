import type { RelatedSummaryRelationKey } from "@cubby/schemas/related-view";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ImageIcon, Search } from "lucide-react";
import { type FC, useEffect, useMemo, useRef, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";
import { cn, formatCurrency } from "~/lib/utils";

const PAGE_SIZE = 25;

type SortField =
  | "target"
  | "latestActivity"
  | "netSpend"
  | "purchaseCount"
  | "expenseCount"
  | "knownAcquiredUnits";
type SummaryRow = {
  target: {
    entity: "product" | "project" | "vendor";
    id: string;
    label: string;
    image: {
      id: string;
      url: string;
      filename: string;
      contentType: string;
    } | null;
  } | null;
  expenseCount: number;
  purchaseCount: number;
  unpricedExpenseCount: number;
  netSpend: number;
  latestActivity: string | null;
  knownAcquiredUnits: number;
  unknownAcquisitionQuantityCount: number;
};

type Column =
  | "target"
  | "acquired"
  | "purchases"
  | "expenses"
  | "unpriced"
  | "netSpend"
  | "latestActivity";

interface RelationshipSummaryTableProps {
  relationKey: RelatedSummaryRelationKey;
  sourceId: string;
  includeSubProjects?: boolean;
  columns: readonly Column[];
  defaultSort: { field: SortField; direction: "asc" | "desc" };
  emptyCopy: string;
  note?: string;
  nullLabel?: string;
  /** Exact ledger scope for one aggregate bucket. */
  expenseHref: (target: SummaryRow["target"]) => string;
  compact?: boolean;
}

const COLUMN_LABELS: Record<Column, string> = {
  target: "Name",
  acquired: "Acquired",
  purchases: "Purchases",
  expenses: "Expenses",
  unpriced: "Unpriced",
  netSpend: "Net spend",
  latestActivity: "Latest",
};

const SORT_BY_COLUMN: Partial<Record<Column, SortField>> = {
  target: "target",
  acquired: "knownAcquiredUnits",
  purchases: "purchaseCount",
  expenses: "expenseCount",
  netSpend: "netSpend",
  latestActivity: "latestActivity",
};

const TARGET_ENTITY_BY_RELATION: Record<
  RelatedSummaryRelationKey,
  NonNullable<SummaryRow["target"]>["entity"]
> = {
  "vendor.products": "product",
  "vendor.projects": "project",
  "purchase.projects": "project",
  "project.vendors": "vendor",
  "project.purchasedProducts": "product",
  "product.vendors": "vendor",
};

function targetImage(
  target: SummaryRow["target"],
  fallbackEntity: NonNullable<SummaryRow["target"]>["entity"],
) {
  if (target?.entity === "vendor") {
    return (
      <div className="flex h-full items-center justify-center">
        <VendorMark vendor={target.label} vendorId={target.id} />
      </div>
    );
  }

  return (
    <ImageThumbnail
      images={target?.image ? [target.image] : []}
      alt={target ? `${target.label} image` : "No linked image"}
      lazyPreview
      entity={target?.entity ?? fallbackEntity}
    />
  );
}

function targetLink(target: NonNullable<SummaryRow["target"]>) {
  return (
    <EntityInlineLink
      entity={target.entity}
      data={{ id: target.id, name: target.label }}
      truncate
    />
  );
}

/**
 * A dense, read-only aggregate table. It deliberately has its own small
 * server-backed paging model instead of an RTable: summary rows are not entity
 * records and none of their grouped values can be edited safely.
 */
export const RelationshipSummaryTable: FC<RelationshipSummaryTableProps> = ({
  relationKey,
  sourceId,
  includeSubProjects,
  columns,
  defaultSort,
  emptyCopy,
  note,
  nullLabel = "Unassigned",
  expenseHref,
  compact = false,
}) => {
  const api = useTRPC();
  const targetEntity = TARGET_ENTITY_BY_RELATION[relationKey];
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(defaultSort);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const appliedPageRef = useRef<string | null>(null);

  const scopeKey = `${relationKey}:${sourceId}:${includeSubProjects === true}:${search}:${sort.field}:${sort.direction}`;
  const queryInput = useMemo(
    () => ({
      relationKey,
      sourceId,
      includeSubProjects,
      search: search || undefined,
      sort,
      offset,
      limit: PAGE_SIZE,
    }),
    [relationKey, sourceId, includeSubProjects, search, sort, offset],
  );
  const query = useQuery(api.relatedData.summary.queryOptions(queryInput));

  useEffect(() => {
    if (!query.data) return;
    const pageKey = `${scopeKey}:${offset}`;
    if (appliedPageRef.current === pageKey) return;
    appliedPageRef.current = pageKey;
    const data: SummaryRow[] = query.data.data;
    setRows((previous) => (offset === 0 ? data : [...previous, ...data]));
    setNextOffset(query.data.nextOffset);
  }, [query.data, scopeKey, offset]);

  const changeSort = (field: SortField) => {
    setSort((previous) => ({
      field,
      direction:
        previous.field === field && previous.direction === "desc"
          ? "asc"
          : "desc",
    }));
    setRows([]);
    setNextOffset(null);
    setOffset(0);
    appliedPageRef.current = null;
  };

  const renderMetric = (row: SummaryRow, column: Exclude<Column, "target">) => {
    switch (column) {
      case "acquired":
        return (
          <span>
            {row.knownAcquiredUnits}
            {row.unknownAcquisitionQuantityCount > 0 && (
              <span className="text-warning">
                {` +${row.unknownAcquisitionQuantityCount}?`}
              </span>
            )}
          </span>
        );
      case "purchases":
        return row.purchaseCount;
      case "expenses":
        return row.expenseCount;
      case "unpriced":
        return row.unpricedExpenseCount === 0 ? "—" : row.unpricedExpenseCount;
      case "netSpend":
        return formatCurrency(row.netSpend);
      case "latestActivity":
        return row.latestActivity ?? "—";
    }
  };

  const loadingInitial = query.isPending && rows.length === 0;
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setRows([]);
              setNextOffset(null);
              setOffset(0);
              appliedPageRef.current = null;
            }}
            placeholder="Search…"
            aria-label="Search relationship summary"
            className="pl-6"
          />
        </div>
        {query.data && (
          <span className="shrink-0 text-right font-mono text-2xs text-muted-foreground tabular-nums">
            {query.data.count} {query.data.count === 1 ? "group" : "groups"}
            {" · "}
            {formatCurrency(query.data.totals.netSpend)} net
            {query.data.totals.unpricedExpenseCount > 0 &&
              ` · ${query.data.totals.unpricedExpenseCount} unpriced`}
          </span>
        )}
      </Row>

      {note && <Description>{note}</Description>}

      {loadingInitial ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <Description>Could not load this relationship summary.</Description>
      ) : rows.length === 0 ? (
        <Description>{emptyCopy}</Description>
      ) : (
        <>
          <Table className={cn("table-auto", compact && "text-2xs")}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">
                  <ImageIcon className="size-3 text-muted-foreground" />
                  <span className="sr-only">Image</span>
                </TableHead>
                {columns.map((column) => {
                  const sortField = SORT_BY_COLUMN[column];
                  const isActive = sortField === sort.field;
                  return (
                    <TableHead
                      key={column}
                      className={cn(
                        column === "target" && "w-full",
                        column !== "target" && "text-right",
                      )}
                    >
                      {sortField ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => changeSort(sortField)}
                          aria-label={`Sort by ${COLUMN_LABELS[column]}`}
                        >
                          {COLUMN_LABELS[column]}
                          {isActive &&
                            (sort.direction === "asc" ? (
                              <ChevronUp className="size-3" />
                            ) : (
                              <ChevronDown className="size-3" />
                            ))}
                        </button>
                      ) : (
                        COLUMN_LABELS[column]
                      )}
                    </TableHead>
                  );
                })}
                <TableHead className="w-0 text-right">
                  <span className="sr-only">Ledger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={row.target?.id ?? `unassigned-${index}`}>
                  <TableCell className="h-px w-16 overflow-hidden px-0 py-0">
                    {targetImage(row.target, targetEntity)}
                  </TableCell>
                  {columns.map((column) => {
                    if (column === "target") {
                      return (
                        <TableCell key={column} className="min-w-48">
                          <Row gap="xs" align="center" className="min-w-0">
                            {row.target ? (
                              targetLink(row.target)
                            ) : (
                              <span className="font-medium text-warning">
                                {nullLabel}
                              </span>
                            )}
                          </Row>
                        </TableCell>
                      );
                    }
                    return (
                      <TableCell
                        key={column}
                        className="text-right font-mono tabular-nums"
                      >
                        {renderMetric(row, column)}
                      </TableCell>
                    );
                  })}
                  <TableCell className="w-0 px-0 text-right">
                    <a
                      href={expenseHref(row.target)}
                      className="text-primary hover:underline"
                      aria-label={`View ${row.target?.label ?? nullLabel} expenses`}
                    >
                      Ledger
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {nextOffset != null && (
            <Row justify="end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={query.isFetching}
                onClick={() => setOffset(nextOffset)}
              >
                {query.isFetching ? "Loading…" : "Load more"}
              </Button>
            </Row>
          )}
        </>
      )}
    </Stack>
  );
};
