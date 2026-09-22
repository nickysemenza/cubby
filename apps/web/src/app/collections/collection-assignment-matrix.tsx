import {
  collectionMatrixMembership,
  collectionMatrixSort,
  collectionSlug,
  type CollectionCellState,
  type CollectionMatrixMembership,
  type CollectionMatrixSort,
  type CollectionSlug,
} from "@cubby/schemas/collection";
import {
  formatCollectionLabel,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, MapPin, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
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
import { focusOnMount } from "~/hooks/focus-on-mount";
import { IDEMPOTENT_MUTATION_RETRY } from "~/integrations/tanstack-query/query-policy";
import { cn } from "~/lib/utils";

import type { CollectionAssignmentSearch } from "./collection-assignment-search";
import {
  CopyableShortcode,
  ProductContextLine,
} from "./collection-product-context";
import {
  type CollectionMatrixRow,
  collection as collectionOperations,
} from "./collection.functions";

const SETTLE_MS = 400;
const MOBILE_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [100, 250, 500] as const;
const EMPTY_COLLECTIONS: CollectionSlug[] = [];
type MatrixRow = CollectionMatrixRow;
type CollectionAssignmentSubject = "product" | "location";

export type CollectionAssignmentOperations = Pick<
  typeof collectionOperations,
  "create" | "matrix" | "set"
>;

const directlyAssigned = (state: CollectionCellState): boolean =>
  state === "direct" || state === "both";

const parseAssignmentSubject = (
  value: string,
): CollectionAssignmentSubject | undefined =>
  value === "product" || value === "location" ? value : undefined;

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

function MobileMatrixPager({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  totalCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-2">
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
        {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
        {totalCount.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous 25 assignments"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next 25 assignments"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function MatrixLoadError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-2 border-y border-border px-2 py-6 text-center"
    >
      <p className="font-medium">Couldn’t load assignments</p>
      <p className="max-w-prose text-xs text-muted-foreground">
        {error.message}
      </p>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function NewCollectionDialog({
  subject,
  rows,
  operations,
}: {
  subject: CollectionAssignmentSubject;
  rows: MatrixRow[];
  operations: CollectionAssignmentOperations;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");
  const nameId = useId();
  const memberSelectId = useId();
  const slug = normalizeCollectionSlug(name);

  const create = useMutation({
    ...operations.create.mutationOptions(),
    onSuccess: (result) => {
      toast.success(`${formatCollectionLabel(result.slug)} created`);
      setOpen(false);
      setName("");
      setMemberId("");
    },
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
                ref={focusOnMount}
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

function buildMatrixViewModel(
  data:
    | {
        collections: CollectionSlug[];
        rows: MatrixRow[];
        totalCount: number;
      }
    | undefined,
  options: {
    subject: CollectionAssignmentSubject;
    page: number;
    pageSize: number;
    mobilePage: number;
    mobileCollection?: CollectionSlug;
    collection?: CollectionSlug;
  },
) {
  const collections = data?.collections ?? EMPTY_COLLECTIONS;
  const matrixRows = data?.rows ?? [];
  const totalCount = data?.totalCount ?? 0;
  const rangeStart =
    totalCount === 0 ? 0 : (options.page - 1) * options.pageSize + 1;
  const selectedMobileCollection = collections.includes(
    options.mobileCollection ?? options.collection ?? "",
  )
    ? (options.mobileCollection ?? options.collection)
    : collections[0];
  const mobileBatchOffset =
    (options.mobilePage - 1) * MOBILE_PAGE_SIZE -
    (options.page - 1) * options.pageSize;
  return {
    collections,
    matrixRows,
    totalCount,
    columns: collections.map((collection) => ({
      key: collection,
      data: collection,
    })),
    rows: matrixRows.map((row) => ({ key: row.id, data: row })),
    pageCount: Math.max(1, Math.ceil(totalCount / options.pageSize)),
    rangeStart,
    rangeEnd: Math.min(options.page * options.pageSize, totalCount),
    subjectLabel: options.subject === "product" ? "Products" : "Locations",
    secondaryLabel: options.subject === "product" ? "Manufacturer" : "Path",
    selectedMobileCollection,
    mobilePageCount: Math.max(1, Math.ceil(totalCount / MOBILE_PAGE_SIZE)),
    mobileRangeStart:
      totalCount === 0 ? 0 : (options.mobilePage - 1) * MOBILE_PAGE_SIZE + 1,
    mobileRangeEnd: Math.min(options.mobilePage * MOBILE_PAGE_SIZE, totalCount),
    mobileRows: matrixRows.slice(
      mobileBatchOffset,
      mobileBatchOffset + MOBILE_PAGE_SIZE,
    ),
  };
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
  operations = collectionOperations,
}: {
  subject: "product" | "location";
  search?: string;
  page: number;
  pageSize: number;
  sort: CollectionMatrixSort;
  collection?: CollectionSlug;
  membership?: CollectionMatrixMembership;
  onSearchChange: (next: CollectionAssignmentSearch) => void;
  /** Remote collection operations; production uses the shared catalog. */
  operations?: CollectionAssignmentOperations;
}) {
  const mobileSubjectId = useId();
  const mobileCollectionId = useId();
  const mobileRowsHeadingId = useId();
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
  const matrix = useQuery(operations.matrix.queryOptions(input));
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [mobileCollection, setMobileCollection] = useState<CollectionSlug>();
  const [mobilePage, setMobilePage] = useState(() =>
    Math.max(1, Math.ceil(((page - 1) * pageSize + 1) / MOBILE_PAGE_SIZE)),
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const mutation = useMutation({
    ...operations.set.mutationOptions(),
    // The command sets the final membership state rather than toggling it, so
    // retrying a transient transport failure cannot apply the action twice.
    retry: IDEMPOTENT_MUTATION_RETRY,
    onSuccess: (_result, variables) => {
      const key = `${variables.subject}:${variables.id}:${variables.collection}`;
      setOverrides((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    onError: (error, variables) => {
      const key = `${variables.subject}:${variables.id}:${variables.collection}`;
      setOverrides((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      showErrorToast(error, "Assignment was restored");
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

  const {
    columns,
    rows,
    pageCount,
    totalCount,
    rangeStart,
    rangeEnd,
    matrixRows,
    subjectLabel,
    secondaryLabel,
    collections: availableCollections,
    selectedMobileCollection,
    mobilePageCount,
    mobileRangeStart,
    mobileRangeEnd,
    mobileRows,
  } = buildMatrixViewModel(matrix.data, {
    subject,
    page,
    pageSize,
    mobilePage,
    mobileCollection,
    collection,
  });

  useEffect(() => {
    if (mobileCollection && availableCollections.includes(mobileCollection)) {
      return;
    }
    setMobileCollection(
      collection && availableCollections.includes(collection)
        ? collection
        : availableCollections[0],
    );
  }, [availableCollections, collection, mobileCollection]);

  useEffect(() => {
    setMobilePage(
      Math.max(1, Math.ceil(((page - 1) * pageSize + 1) / MOBILE_PAGE_SIZE)),
    );
  }, [page, pageSize]);

  const changeMobilePage = (nextPage: number) => {
    const nextServerPage =
      Math.floor(((nextPage - 1) * MOBILE_PAGE_SIZE) / pageSize) + 1;
    setMobilePage(nextPage);
    if (nextServerPage !== page) onSearchChange({ page: nextServerPage });
  };
  const changeSubject = (value: string) => {
    const nextSubject = parseAssignmentSubject(value);
    if (nextSubject) onSearchChange({ subject: nextSubject, page: 1 });
  };

  return (
    <Stack gap="xs" className="pb-24">
      <div className="hidden border-y border-border bg-card md:block">
        <div className="flex min-h-9 flex-wrap items-center gap-2 border-b border-border px-2">
          <Tabs value={subject} onValueChange={changeSubject}>
            <TabsList variant="line" aria-label="Assignment subject">
              <TabsTrigger value="product">Products</TabsTrigger>
              <TabsTrigger value="location">Locations</TabsTrigger>
            </TabsList>
          </Tabs>
          <NewCollectionDialog
            subject={subject}
            rows={matrixRows}
            operations={operations}
          />
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
              const selected = collectionSlug.safeParse(event.target.value);
              onSearchChange({
                collection: selected.success ? selected.data : undefined,
                membership: selected.success ? "member" : undefined,
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
            onChange={(event) => {
              const nextMembership = collectionMatrixMembership.safeParse(
                event.target.value,
              );
              onSearchChange({
                membership: nextMembership.success
                  ? nextMembership.data
                  : undefined,
                page: 1,
              });
            }}
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
            onChange={(event) => {
              const nextSort = collectionMatrixSort.safeParse(
                event.target.value,
              );
              if (nextSort.success) {
                onSearchChange({ sort: nextSort.data, page: 1 });
              }
            }}
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
              onSearchChange({
                // SAFETY: the schema's `.refine` narrows to the literal options below
                // (TS infers it as a type predicate); the select's own
                // `<option>`s are generated from the same array, so the parsed
                // value is always one of them.
                rows: Number(
                  event.target.value,
                ) as (typeof PAGE_SIZE_OPTIONS)[number],
                page: 1,
              })
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

      <div className="overflow-x-hidden border-y border-border md:hidden">
        {matrix.isLoading ? (
          <p className="px-2 py-6 text-center text-muted-foreground">
            Loading assignments…
          </p>
        ) : matrix.error ? (
          <MatrixLoadError
            error={matrix.error}
            onRetry={() => matrix.refetch()}
          />
        ) : availableCollections.length === 0 ? (
          <div className="grid gap-2 px-2 py-4">
            <label
              htmlFor={mobileSubjectId}
              className="grid gap-1 text-xs font-medium"
            >
              Show rows for
              <NativeSelect
                id={mobileSubjectId}
                aria-label="Assignment subject"
                value={subject}
                onChange={(event) => changeSubject(event.target.value)}
              >
                <option value="product">Products</option>
                <option value="location">Locations</option>
              </NativeSelect>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">No Collections yet</p>
                <p className="text-xs text-muted-foreground">
                  Start with one {subject} from this page.
                </p>
              </div>
              <NewCollectionDialog
                subject={subject}
                rows={matrixRows}
                operations={operations}
              />
            </div>
          </div>
        ) : (
          <div>
            <div className="grid gap-2 border-b border-border bg-card px-2 py-2">
              <label
                htmlFor={mobileSubjectId}
                className="grid gap-1 text-xs font-medium"
              >
                Show rows for
                <NativeSelect
                  id={mobileSubjectId}
                  aria-label="Assignment subject"
                  value={subject}
                  onChange={(event) => changeSubject(event.target.value)}
                >
                  <option value="product">Products</option>
                  <option value="location">Locations</option>
                </NativeSelect>
              </label>
              <label
                htmlFor={mobileCollectionId}
                className="grid gap-1 text-xs font-medium"
              >
                Assign to Collection
                <NativeSelect
                  id={mobileCollectionId}
                  aria-label="Assign to Collection"
                  value={selectedMobileCollection ?? ""}
                  onChange={(event) => {
                    const nextCollection = collectionSlug.safeParse(
                      event.target.value,
                    );
                    setMobileCollection(
                      nextCollection.success ? nextCollection.data : undefined,
                    );
                  }}
                >
                  {availableCollections.map((slug) => (
                    <option key={slug} value={slug}>
                      {formatCollectionLabel(slug)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <div className="flex items-center justify-between gap-2 font-mono text-2xs text-muted-foreground tabular-nums">
                <span>
                  {mobileRangeStart.toLocaleString()}–
                  {mobileRangeEnd.toLocaleString()} of{" "}
                  {totalCount.toLocaleString()}
                </span>
                <span>Direct assignments are editable</span>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-muted-foreground">
                No {subjectLabel.toLocaleLowerCase()} match these filters.
              </p>
            ) : mobileRows.length === 0 ? (
              <p className="px-2 py-6 text-center text-muted-foreground">
                Loading the next assignments…
              </p>
            ) : (
              <section aria-labelledby={mobileRowsHeadingId}>
                <h2
                  id={mobileRowsHeadingId}
                  className="border-b border-border bg-muted/30 px-2 py-2 font-mono text-2xs tracking-wider text-muted-foreground uppercase"
                >
                  {subjectLabel}
                </h2>
                <ul className="divide-y divide-border">
                  {mobileRows.map((row) => {
                    const state = selectedMobileCollection
                      ? (row.states[selectedMobileCollection] ?? "empty")
                      : "empty";
                    const key = selectedMobileCollection
                      ? `${subject}:${row.id}:${selectedMobileCollection}`
                      : "";
                    const assigned = selectedMobileCollection
                      ? (overrides[key] ?? directlyAssigned(state))
                      : false;
                    const inherited = state === "inherited" || state === "both";
                    const assignmentLabel = assigned
                      ? "Direct"
                      : inherited
                        ? "Inherited"
                        : "Assign";

                    return (
                      <li
                        key={row.id}
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5"
                      >
                        <div className="flex min-h-11 min-w-0 items-center gap-2">
                          <Image
                            src={row.imageUrl ?? ""}
                            alt=""
                            displayWidth={32}
                            className="size-8 shrink-0 border border-border bg-card object-cover"
                            fallback={
                              <EntityIcon
                                entity={subject}
                                className="size-3.5 text-muted-foreground"
                              />
                            }
                          />
                          <div className="min-w-0">
                            <Link
                              {...entityDetailLink(subject, row.id)}
                              title={row.name}
                              className="flex min-h-11 items-center truncate font-medium underline decoration-border/70 decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary hover:decoration-solid"
                            >
                              {row.name}
                            </Link>
                            {row.secondary && (
                              <p
                                className="truncate text-2xs text-muted-foreground"
                                title={row.secondary}
                              >
                                {row.secondary}
                              </p>
                            )}
                            {inherited && !assigned && (
                              <p className="text-2xs text-muted-foreground">
                                Inherited membership remains if removed.
                              </p>
                            )}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant={assigned ? "secondary" : "outline"}
                          size="sm"
                          aria-pressed={assigned}
                          aria-label={`${assigned ? "Remove" : "Add"} direct ${formatCollectionLabel(selectedMobileCollection ?? "collection")} assignment for ${row.name}${inherited ? "; inherited membership remains" : ""}`}
                          disabled={!selectedMobileCollection}
                          onClick={() => {
                            if (selectedMobileCollection) {
                              schedule(row, selectedMobileCollection);
                            }
                          }}
                        >
                          {assigned && <Check />}
                          {inherited && !assigned && <MapPin />}
                          {assignmentLabel}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <div className="border-t border-border">
              <MobileMatrixPager
                page={mobilePage}
                pageCount={mobilePageCount}
                rangeStart={mobileRangeStart}
                rangeEnd={mobileRangeEnd}
                totalCount={totalCount}
                onPageChange={changeMobilePage}
              />
            </div>
          </div>
        )}
      </div>

      <div className="hidden md:block">
        {matrix.isLoading ? (
          <p className="py-8 text-center text-muted-foreground">
            Loading assignments…
          </p>
        ) : matrix.error ? (
          <MatrixLoadError
            error={matrix.error}
            onRetry={() => matrix.refetch()}
          />
        ) : columns.length === 0 ? (
          <p className="border-y border-border py-8 text-center text-muted-foreground">
            Create a Collection before managing assignments.
          </p>
        ) : rows.length === 0 ? (
          <p className="border-y border-border py-8 text-center text-muted-foreground">
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
              <span className="block text-center font-mono text-2xs tracking-wider break-words uppercase">
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
                      className="truncate text-2xs font-normal text-muted-foreground"
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
                    "group/cell relative grid h-12 w-full place-items-center border-l border-border focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
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

      <div className="hidden items-center justify-between gap-2 border-t border-border pt-1 md:flex">
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
