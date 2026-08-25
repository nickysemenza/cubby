import type {
  CollectionCellState,
  CollectionMatrixMembership,
  CollectionMatrixSort,
  CollectionSlug,
} from "@cubby/schemas/collection";
import {
  formatCollectionLabel,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, MapPin, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Stack } from "~/components/layout";
import { CrossTabTable } from "~/components/matrix/cross-tab-table";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { EntityIcon, entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateQueryRoots } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
import {
  type CollectionMatrixRow,
  collectionCreateMutationOptions,
  collectionDetailRootKey,
  collectionListRootKey,
  collectionMatrixQueryOptions,
  collectionMatrixRootKey,
  collectionSetMutationOptions,
} from "./collection.functions";
import {
  CopyableShortcode,
  ProductContextLine,
} from "./collection-product-context";

const SETTLE_MS = 400;
const PAGE_SIZE_OPTIONS = [100, 250, 500] as const;
type MatrixRow = CollectionMatrixRow;

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

function NewCollectionDialog({
  subject,
  rows,
}: {
  subject: "product" | "location";
  rows: MatrixRow[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");
  const nameId = useId();
  const memberSelectId = useId();
  const slug = normalizeCollectionSlug(name);

  const create = useMutation({
    ...collectionCreateMutationOptions(),
    onSuccess: (result) => {
      invalidateQueryRoots(queryClient, [
        collectionMatrixRootKey(),
        collectionListRootKey(),
        collectionDetailRootKey(),
      ]);
      toast.success(`${formatCollectionLabel(result.slug)} created`);
      setOpen(false);
      setName("");
      setMemberId("");
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setMemberId(rows[0]?.id ?? "");
    if (!nextOpen) {
      setName("");
      setMemberId("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" disabled={rows.length === 0}>
            <Plus /> New Collection
          </Button>
        }
      />
      <DialogContent size="md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!slug || !memberId) return;
            create.mutate({
              collection: slug,
              subject,
              id: memberId,
            });
          }}
        >
          <Stack gap="md">
            <DialogHeader>
              <DialogTitle>New Collection</DialogTitle>
              <DialogDescription>
                Start with one {subject}. You can assign more as soon as its
                column appears.
              </DialogDescription>
            </DialogHeader>
            <Stack gap="xs">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Painting"
                autoFocus
              />
            </Stack>
            <Stack gap="xs">
              <Label htmlFor={memberSelectId}>First {subject}</Label>
              <NativeSelect
                id={memberSelectId}
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
              >
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.secondary ? ` — ${row.secondary}` : ""}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-2xs text-muted-foreground">
                Choose from the current filtered page.
              </p>
            </Stack>
            <DialogFooter>
              <Button
                type="submit"
                disabled={!slug || !memberId || create.isPending}
              >
                Create Collection
              </Button>
            </DialogFooter>
          </Stack>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CollectionAssignmentMatrix({
  subject,
  search,
  page,
  pageSize,
  sort,
  collection,
  membership,
  onSearchChange,
}: {
  subject: "product" | "location";
  search?: string;
  page: number;
  pageSize: number;
  sort: CollectionMatrixSort;
  collection?: CollectionSlug;
  membership?: CollectionMatrixMembership;
  onSearchChange: (next: {
    subject?: "product" | "location";
    q?: string;
    page?: number;
    rows?: number;
    sort?: CollectionMatrixSort;
    collection?: CollectionSlug;
    membership?: CollectionMatrixMembership;
  }) => void;
}) {
  const queryClient = useQueryClient();
  const input = useMemo(
    () => ({
      subject,
      search,
      sort,
      collection,
      membership,
      pagination: { pageIndex: page - 1, pageSize },
    }),
    [collection, membership, page, pageSize, search, sort, subject],
  );
  const matrix = useQuery(collectionMatrixQueryOptions(input));
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const mutation = useMutation({
    ...collectionSetMutationOptions(),
    retry: 2,
    onSuccess: (_result, variables) => {
      const key = `${variables.subject}:${variables.id}:${variables.collection}`;
      setOverrides((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      invalidateQueryRoots(queryClient, [
        collectionMatrixRootKey(),
        collectionListRootKey(),
        collectionDetailRootKey(),
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
  });

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
        });
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
    Math.ceil((matrix.data?.totalCount ?? 0) / pageSize),
  );
  const totalCount = matrix.data?.totalCount ?? 0;
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalCount);
  const matrixRows = matrix.data?.rows ?? [];
  const subjectLabel = subject === "product" ? "Products" : "Locations";
  const secondaryLabel = subject === "product" ? "Manufacturer" : "Path";

  return (
    <Stack gap="xs" className="pb-24">
      <div className="hidden border-border border-y bg-card md:block">
        <div className="flex min-h-9 flex-wrap items-center gap-2 border-border border-b px-2">
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
          <NewCollectionDialog subject={subject} rows={matrixRows} />
          <div className="ml-auto flex items-center gap-4 font-mono text-2xs text-muted-foreground">
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

        <div className="flex flex-wrap items-center gap-2 px-2 py-1">
          <Input
            className="w-64"
            value={search ?? ""}
            onChange={(event) =>
              onSearchChange({ q: event.target.value || undefined, page: 1 })
            }
            placeholder={`Search ${subjectLabel.toLocaleLowerCase()} or ${secondaryLabel.toLocaleLowerCase()}`}
            aria-label={`Search ${subjectLabel.toLocaleLowerCase()}`}
          />
          <NativeSelect
            aria-label="Filter by Collection"
            value={collection ?? ""}
            onChange={(event) => {
              const selected = event.target.value as CollectionSlug | "";
              onSearchChange({
                collection: selected || undefined,
                membership: selected ? "member" : undefined,
                page: 1,
              });
            }}
          >
            <option value="">Any Collection</option>
            {(matrix.data?.collections ?? []).map((slug) => (
              <option key={slug} value={slug}>
                {formatCollectionLabel(slug)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Filter by membership"
            value={membership ?? ""}
            disabled={!collection}
            onChange={(event) =>
              onSearchChange({
                membership:
                  (event.target.value as CollectionMatrixMembership) ||
                  undefined,
                page: 1,
              })
            }
          >
            <option value="">Any membership</option>
            <option value="member">Member</option>
            <option value="direct">Direct assignment</option>
            <option value="inherited">Inherited membership</option>
            <option value="unassigned">Not a member</option>
          </NativeSelect>
          <NativeSelect
            aria-label={`Sort ${subjectLabel.toLocaleLowerCase()}`}
            value={sort}
            onChange={(event) =>
              onSearchChange({
                sort: event.target.value as CollectionMatrixSort,
                page: 1,
              })
            }
          >
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="secondary-asc">{secondaryLabel} A–Z</option>
            <option value="secondary-desc">{secondaryLabel} Z–A</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Rows per page"
            value={pageSize}
            onChange={(event) =>
              onSearchChange({ rows: Number(event.target.value), page: 1 })
            }
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option} rows
              </option>
            ))}
          </NativeSelect>
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
            No {subjectLabel.toLocaleLowerCase()} match these filters.
          </p>
        ) : (
          <CrossTabTable
            cornerLabel={subject === "product" ? "Product" : "Location"}
            columns={columns}
            rows={rows}
            layout={{ rowHeader: 420, column: 96, pinned: 0 }}
            surface="background"
            density="compact"
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
              <div className="flex min-w-0 items-center gap-2 py-1">
                <Image
                  src={row.data.imageUrl ?? ""}
                  alt={`${row.data.name} cover`}
                  displayWidth={32}
                  className="size-8 shrink-0 border border-border bg-card object-cover"
                  fallback={
                    <EntityIcon
                      entity={subject}
                      className="size-3.5 text-muted-foreground"
                    />
                  }
                />
                <div className="min-w-0 leading-tight">
                  <Link
                    {...entityDetailLink(subject, row.data.id)}
                    title={row.data.name}
                    className="block truncate font-medium underline decoration-border/70 decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary hover:decoration-solid"
                  >
                    {row.data.name}
                  </Link>
                  {row.data.secondary && (
                    <div
                      className="truncate font-normal text-2xs text-muted-foreground"
                      title={row.data.secondary}
                    >
                      {row.data.secondary}
                    </div>
                  )}
                  {subject === "product" ? (
                    <ProductContextLine
                      shortcode={row.data.id}
                      placements={row.data.placements}
                      purchases={row.data.purchases}
                      className="mt-1"
                    />
                  ) : (
                    <CopyableShortcode code={row.data.id} className="mt-1" />
                  )}
                </div>
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
                    "group/cell relative grid h-12 w-full place-items-center border-border border-l focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                    assigned
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted/40",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-4 place-items-center border bg-background transition-colors",
                      assigned
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border group-hover/cell:border-primary",
                    )}
                  >
                    {assigned && <Check className="size-3" />}
                  </span>
                  {inherited && (
                    <MapPin
                      className={cn(
                        "absolute right-1 bottom-1 size-3",
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

      <div className="hidden items-center justify-between gap-2 border-border border-t pt-1 md:flex">
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
          {totalCount.toLocaleString()}
        </span>
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
