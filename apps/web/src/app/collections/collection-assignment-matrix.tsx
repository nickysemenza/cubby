import type { CollectionCellState } from "@cubby/schemas/collection";
import { formatCollectionLabel } from "@cubby/shared/collection-tag";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Stack } from "~/components/layout";
import { CrossTabTable } from "~/components/matrix/cross-tab-table";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { type RouterOutputs, useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { cn } from "~/lib/utils";

const PAGE_SIZE = 50;
const SETTLE_MS = 400;
type MatrixRow = RouterOutputs["collection"]["matrix"]["rows"][number];

const directlyAssigned = (state: CollectionCellState): boolean =>
  state === "direct" || state === "both";

function MatrixPager({
  page,
  pageCount,
  placement,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  placement: "top" | "bottom";
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Previous page, ${placement} controls`}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <span className="font-mono text-2xs tabular-nums">
        Page {page} / {pageCount}
      </span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Next page, ${placement} controls`}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

export function CollectionAssignmentMatrix({
  subject,
  search,
  page,
  onSearchChange,
}: {
  subject: "product" | "location";
  search?: string;
  page: number;
  onSearchChange: (next: {
    subject?: "product" | "location";
    q?: string;
    page?: number;
  }) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const input = useMemo(
    () => ({
      subject,
      search,
      pagination: { pageIndex: page - 1, pageSize: PAGE_SIZE },
    }),
    [page, search, subject],
  );
  const matrix = useQuery(api.collection.matrix.queryOptions(input));
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const mutation = useMutation(
    api.collection.set.mutationOptions({
      retry: 2,
      onSuccess: (_result, variables) => {
        const key = `${variables.subject}:${variables.id}:${variables.collection}`;
        setOverrides((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        invalidateTRPCQueries(queryClient, [
          api.collection.matrix.queryKey(),
          api.collection.list.queryKey(),
          api.collection.detail.queryKey(),
        ]);
      },
      onError: (error, variables) => {
        const key = `${variables.subject}:${variables.id}:${variables.collection}`;
        setOverrides((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        toast.error(`Assignment was restored: ${getErrorMessage(error)}`);
      },
    }),
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const schedule = (row: MatrixRow, collection: string) => {
    const state = row.states[collection] ?? "empty";
    const key = `${subject}:${row.id}:${collection}`;
    const serverValue = directlyAssigned(state);
    const currentValue = overrides[key] ?? serverValue;
    const nextValue = !currentValue;
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);

    if (nextValue === serverValue) {
      timers.current.delete(key);
      setOverrides((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }

    setOverrides((current) => ({ ...current, [key]: nextValue }));
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        mutation.mutate({
          subject,
          id: row.id,
          collection,
          assigned: nextValue,
        } as never);
      }, SETTLE_MS),
    );
  };

  const columns = (matrix.data?.collections ?? []).map((collection) => ({
    key: collection,
    data: collection,
  }));
  const rows = (matrix.data?.rows ?? []).map((row) => ({
    key: row.id,
    data: row,
  }));
  const pageCount = Math.max(
    1,
    Math.ceil((matrix.data?.totalCount ?? 0) / PAGE_SIZE),
  );
  const totalCount = matrix.data?.totalCount ?? 0;
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  return (
    <Stack gap="sm" className="pb-24">
      <Tabs
        className="hidden md:block"
        value={subject}
        onValueChange={(value) =>
          onSearchChange({
            subject: value as "product" | "location",
            page: 1,
          })
        }
      >
        <TabsList variant="line" aria-label="Assignment subject">
          <TabsTrigger value="product">Products</TabsTrigger>
          <TabsTrigger value="location">Locations</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="hidden flex-wrap items-center gap-2 border-border border-y py-2 md:flex">
        <Input
          className="w-full md:w-72"
          value={search ?? ""}
          onChange={(event) =>
            onSearchChange({ q: event.target.value || undefined, page: 1 })
          }
          placeholder={`Search ${subject === "product" ? "products" : "locations"}`}
          aria-label={`Search ${subject}`}
        />
        <span className="ml-auto font-mono text-2xs text-muted-foreground tabular-nums">
          {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
          {totalCount.toLocaleString()}
        </span>
        <MatrixPager
          page={page}
          pageCount={pageCount}
          placement="top"
          onPageChange={(nextPage) => onSearchChange({ page: nextPage })}
        />
        <div className="flex items-center gap-4 font-mono text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block size-3 border border-primary bg-primary" />
            direct
          </span>
          <span className="flex items-center gap-1">
            <MapPin className="size-3" />
            inherited
          </span>
        </div>
      </div>

      <div className="border-border border-y py-6 text-center md:hidden">
        <p className="font-medium">Use the Product or Location form</p>
        <p className="text-muted-foreground text-xs">
          The dense assignment matrix is available on a wider screen.
        </p>
      </div>

      <div className="hidden md:block">
        {matrix.isLoading ? (
          <p className="py-8 text-center text-muted-foreground">
            Loading assignments…
          </p>
        ) : matrix.error ? (
          <p className="py-8 text-center text-destructive">
            {matrix.error.message}
          </p>
        ) : columns.length === 0 ? (
          <p className="border-border border-y py-8 text-center text-muted-foreground">
            Create a Collection before managing assignments.
          </p>
        ) : rows.length === 0 ? (
          <p className="border-border border-y py-8 text-center text-muted-foreground">
            No {subject === "product" ? "products" : "locations"} match this
            search.
          </p>
        ) : (
          <CrossTabTable
            cornerLabel={subject === "product" ? "Product" : "Location"}
            columns={columns}
            rows={rows}
            layout={{ rowHeader: 280, column: 112, pinned: 0 }}
            surface="background"
            bareCells
            rowHover
            caption="Collection assignment matrix"
            className="min-w-full"
            renderColumnHeader={(column) => (
              <span className="block break-words text-center font-mono text-2xs uppercase tracking-wider">
                {formatCollectionLabel(column.data)}
              </span>
            )}
            renderRowHeader={(row) => (
              <div className="min-w-0">
                <div className="truncate">{row.data.name}</div>
                {row.data.secondary && (
                  <div className="truncate font-normal text-2xs text-muted-foreground">
                    {row.data.secondary}
                  </div>
                )}
              </div>
            )}
            cellTitle={(row, column) => {
              const state = row.data.states[column.data] ?? "empty";
              return `${row.data.name}: ${formatCollectionLabel(column.data)} — ${state}`;
            }}
            renderCell={(row, column) => {
              const state = row.data.states[column.data] ?? "empty";
              const key = `${subject}:${row.data.id}:${column.data}`;
              const assigned = overrides[key] ?? directlyAssigned(state);
              const inherited = state === "inherited" || state === "both";
              return (
                <button
                  type="button"
                  aria-pressed={assigned}
                  aria-label={`${assigned ? "Remove" : "Add"} direct ${formatCollectionLabel(column.data)} assignment for ${row.data.name}${inherited ? "; inherited membership remains" : ""}`}
                  title={`${row.data.name}: ${formatCollectionLabel(column.data)} — ${state}`}
                  onClick={() => schedule(row.data, column.data)}
                  className={cn(
                    "group/cell relative grid min-h-10 w-full place-items-center border-border border-l focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                    assigned
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted/40",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-5 place-items-center border bg-background transition-colors",
                      assigned
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border group-hover/cell:border-primary",
                    )}
                  >
                    {assigned && <Check className="size-3.5" />}
                  </span>
                  {inherited && (
                    <MapPin
                      className={cn(
                        "absolute right-2 bottom-1 size-3",
                        assigned ? "text-primary/70" : "text-muted-foreground",
                      )}
                    />
                  )}
                </button>
              );
            }}
          />
        )}
      </div>

      <div className="hidden items-center justify-end gap-2 md:flex">
        <MatrixPager
          page={page}
          pageCount={pageCount}
          placement="bottom"
          onPageChange={(nextPage) => onSearchChange({ page: nextPage })}
        />
      </div>
    </Stack>
  );
}
