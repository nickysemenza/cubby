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

const PAGE_SIZE = 25;
const SETTLE_MS = 400;
type MatrixRow = RouterOutputs["collection"]["matrix"]["rows"][number];

const directlyAssigned = (state: CollectionCellState): boolean =>
  state === "direct" || state === "both";

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

  return (
    <Stack gap="md" className="pb-24">
      <Tabs
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          className="w-full md:w-72"
          value={search ?? ""}
          onChange={(event) =>
            onSearchChange({ q: event.target.value || undefined, page: 1 })
          }
          placeholder={`Search ${subject === "product" ? "products" : "locations"}`}
          aria-label={`Search ${subject}`}
        />
        <div className="flex gap-4 font-mono text-2xs text-muted-foreground">
          <span>
            <span className="mr-1 inline-block size-2 border border-primary bg-primary" />{" "}
            direct
          </span>
          <span>
            <span className="mr-1 inline-block size-2 border border-foreground/50 border-dashed" />{" "}
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
        ) : (
          <CrossTabTable
            cornerLabel={subject === "product" ? "Product" : "Location"}
            columns={columns}
            rows={rows}
            layout={{ rowHeader: 240, column: 88, pinned: 0 }}
            surface="background"
            stickyHeaderTop="top-[51px]"
            bareCells
            rowHover
            caption="Collection assignment matrix"
            renderColumnHeader={(column) => (
              <span className="inline-block max-w-20 break-words text-right font-mono text-2xs uppercase tracking-wider">
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
                  onClick={() => schedule(row.data, column.data)}
                  className={cn(
                    "relative grid min-h-10 w-full place-items-center border-border border-l focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                    assigned
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted/40",
                  )}
                >
                  {assigned && <Check className="size-4" />}
                  {inherited && (
                    <MapPin
                      className={cn(
                        "absolute right-1 bottom-1 size-2.5",
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
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onSearchChange({ page: page - 1 })}
        >
          <ChevronLeft />
        </Button>
        <span className="font-mono text-2xs">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onSearchChange({ page: page + 1 })}
        >
          <ChevronRight />
        </Button>
      </div>
    </Stack>
  );
}
