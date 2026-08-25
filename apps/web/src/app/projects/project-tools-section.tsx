import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type {
  ProjectResourceOut,
  ProjectToolSuggestionOut,
} from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { Plus, Search, Wrench } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createActionsColumn,
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { ProductAddToInventoryDialog } from "~/app/_components/products/product-add-to-inventory-dialog";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import {
  cancelQueryRoots,
  invalidateQueryRoots,
  invalidatesFor,
} from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";

const EMPTY_RESOURCES: ProjectResourceOut[] = [];
const EMPTY_SUGGESTIONS: ProjectToolSuggestionOut[] = [];

type ResourceRow = {
  /** Branded: every construction site feeds this a product shortcode. */
  id: ProductShortcode;
  name: string;
  manufacturer: string;
  category: string;
  images: Array<{ id: string; url: string; filename: string }>;
  uses: number;
  lifetimeCost: number;
  costPerUse: number | null;
  projectPurchaseCost: number | null;
  sharedSpend: string | null;
};

type PickerRow = ResourceRow & {
  reasons: string[];
  trade: string | null;
};

function imagesFor(id: string, name: string, url: string | null) {
  return url ? [{ id: `cover:${id}`, url, filename: name }] : [];
}

function ResourcesTable({
  rows,
  projectId,
  resourcesKey,
  isLoading,
}: {
  rows: ResourceRow[];
  projectId: string;
  resourcesKey: QueryKey;
  isLoading: boolean;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const detachBase = api.project.detachResources.mutationOptions();
  const detach = useMutation({
    mutationKey: detachBase.mutationKey,
    mutationFn: detachBase.mutationFn,
    onMutate: async (variables) => {
      await cancelQueryRoots(queryClient, [resourcesKey]);
      const previous =
        queryClient.getQueryData<ProjectResourceOut[]>(resourcesKey);
      queryClient.setQueryData<ProjectResourceOut[]>(resourcesKey, (current) =>
        current?.filter(
          (item) => !variables.productIds.includes(item.productId),
        ),
      );
      return { previous };
    },
    onSuccess: () => toast.success("Removed resource from this project"),
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(resourcesKey, context.previous);
      toast.error(getErrorMessage(error));
    },
    onSettled: () =>
      invalidateQueryRoots(queryClient, invalidatesFor("project", "resource")),
  });
  const [addToInventoryRow, setAddToInventoryRow] =
    useState<ResourceRow | null>(null);
  const helper = useMemo(() => createCubbyColumnHelper<ResourceRow>(), []);
  const columns = useMemo<CubbyColumnDef<ResourceRow>[]>(
    () => [
      createImageColumn(helper, { entity: "product" }),
      createNameColumn(helper, "product", "name", { header: "Product" }),
      helper.accessor((row) => row.category, {
        id: "type",
        header: "Type",
        meta: { className: "w-24", mobile: { slot: "subtitle" } },
        cell: (info) => (info.getValue() === "software" ? "Software" : "Tool"),
      }),
      helper.accessor((row) => row.uses, {
        id: "uses",
        header: "Uses",
        meta: { className: "w-20", numeric: true, mobile: { slot: "meta" } },
      }),
      createCurrencyColumn(helper, "lifetimeCost", {
        header: "Lifetime cost",
        mobile: { slot: "meta", priority: 20 },
      }),
      helper.accessor((row) => row, {
        id: "effectiveCost",
        header: "Cost / use or project",
        enableSorting: false,
        meta: {
          className: "w-44",
          numeric: true,
          mobile: { slot: "meta", priority: 30, label: "Effective" },
        },
        cell: (info) => {
          const row = info.row.original;
          if (row.sharedSpend)
            return <Description size="xs">{row.sharedSpend}</Description>;
          if (row.projectPurchaseCost != null && row.projectPurchaseCost > 0) {
            return `${formatCurrency(row.projectPurchaseCost)} bought here`;
          }
          return row.costPerUse == null
            ? "Cost/use pending"
            : `${formatCurrency(row.costPerUse)} / use`;
        },
      }),
      createActionsColumn(helper, "product", {
        extraActions: (row) => (
          <>
            <VerbMenuItem
              verb="addToInventory"
              onSelect={(event) => {
                event.stopPropagation();
                setAddToInventoryRow(row);
              }}
            />
            <VerbMenuItem
              verb="removeFromProject"
              disabled={detach.isPending}
              onSelect={(event) => {
                event.stopPropagation();
                detach.mutate({ projectId, productIds: [row.id] });
              }}
            />
          </>
        ),
      }),
    ],
    [detach, helper, projectId],
  );
  const layout = useCubbyTableLayout({ key: "project:resources", columns });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });
  return (
    <>
      <RTable
        table={table}
        entity="product"
        ariaLabel="Reusable project resources"
        embedded
        isLoading={isLoading}
        emptyState={
          <Empty variant="minimal" className="py-6">
            <EmptyHeader>
              <EmptyTitle>No reusable resources recorded</EmptyTitle>
              <EmptyDescription>
                Add meaningful durable tools and shared software. Small
                consumables do not need to become project-use records.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      {addToInventoryRow && (
        <ProductAddToInventoryDialog
          open
          onOpenChange={(open) => {
            if (!open) setAddToInventoryRow(null);
          }}
          product={addToInventoryRow}
        />
      )}
    </>
  );
}

function SelectableResourceTable({
  rows,
  selected,
  setSelected,
  isLoading,
  suggested,
  emptyCopy,
}: {
  rows: PickerRow[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  isLoading: boolean;
  suggested: boolean;
  emptyCopy: string;
}) {
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...selected].map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next =
      typeof updater === "function" ? updater(rowSelection) : updater;
    setSelected(
      new Set(
        Object.entries(next)
          .filter(([, value]) => value)
          .map(([id]) => id),
      ),
    );
  };
  const helper = useMemo(() => createCubbyColumnHelper<PickerRow>(), []);
  const columns = useMemo<CubbyColumnDef<PickerRow>[]>(
    () => [
      buildSelectColumn<PickerRow>(),
      createImageColumn(helper, { entity: "product" }),
      createNameColumn(helper, "product", "name", { header: "Product" }),
      ...(suggested
        ? [
            helper.accessor((row) => row.reasons, {
              id: "reasons",
              header: "Reasons / trade",
              enableSorting: false,
              meta: { className: "w-52", mobile: { slot: "subtitle" } },
              cell: (info) => (
                <Row wrap gap="xs">
                  {info.getValue().map((reason) => (
                    <Badge key={reason} variant="outline">
                      {reason}
                    </Badge>
                  ))}
                  {info.row.original.trade && (
                    <Badge variant="outline">{info.row.original.trade}</Badge>
                  )}
                </Row>
              ),
            }),
            helper.accessor((row) => row.uses, {
              id: "uses",
              header: "Uses",
              meta: {
                className: "w-20",
                numeric: true,
                mobile: { slot: "meta" },
              },
            }),
            createCurrencyColumn(helper, "lifetimeCost", {
              header: "Lifetime cost",
              mobile: { slot: "meta", priority: 20 },
            }),
            helper.accessor((row) => row, {
              id: "effectiveCost",
              header: "Cost / use",
              enableSorting: false,
              meta: {
                className: "w-36",
                numeric: true,
                mobile: { slot: "meta", priority: 30 },
              },
              cell: (info) => {
                const row = info.row.original;
                return row.projectPurchaseCost != null &&
                  row.projectPurchaseCost > 0
                  ? `${formatCurrency(row.projectPurchaseCost)} bought here`
                  : row.costPerUse == null
                    ? "Pending"
                    : formatCurrency(row.costPerUse);
              },
            }),
          ]
        : [
            helper.accessor((row) => row.manufacturer, {
              id: "manufacturer",
              header: "Manufacturer",
              meta: {
                className: "w-40",
                mobile: { slot: "subtitle", label: "Maker" },
              },
              cell: (info) =>
                isUnspecifiedManufacturer(info.getValue())
                  ? "—"
                  : info.getValue(),
            }),
            helper.accessor((row) => row.category, {
              id: "category",
              header: "Category",
              meta: { className: "w-32", mobile: { slot: "meta" } },
            }),
          ]),
    ],
    [helper, suggested],
  );
  const layoutKey = suggested
    ? "project:resource-suggestions"
    : "project:resource-picker";
  const layout = useCubbyTableLayout({ key: layoutKey, columns });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });
  return (
    <div className="max-h-96 overflow-y-auto">
      <RTable
        table={table}
        entity="product"
        ariaLabel={
          suggested
            ? "Suggested project tools"
            : "Products available as resources"
        }
        embedded
        isLoading={isLoading}
        emptyState={<Description>{emptyCopy}</Description>}
      />
    </div>
  );
}

function ResourcePickerDialog({
  open,
  onOpenChange,
  projectId,
  attachedIds,
  resourcesKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  attachedIds: Set<string>;
  resourcesKey: QueryKey;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const suggestionsQuery = useQuery(
    api.project.toolSuggestions.queryOptions({ projectId }, { enabled: open }),
  );
  const toolSearchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search || undefined, categoryFilter: "tools" },
      pagination: { pageIndex: 0, pageSize: 50 },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const softwareSearchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search || undefined, categoryFilter: "software" },
      pagination: { pageIndex: 0, pageSize: 50 },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const suggestions = suggestionsQuery.data?.items ?? EMPTY_SUGGESTIONS;
  const suggestionRows = useMemo<PickerRow[]>(
    () =>
      suggestions.map((item) => ({
        id: item.productId,
        name: item.productName,
        manufacturer: item.manufacturer,
        category: "tools",
        images: imagesFor(item.productId, item.productName, item.coverImageUrl),
        uses: item.projectUseCount,
        lifetimeCost: item.netLifetimeCost,
        costPerUse: item.costPerProjectUse,
        projectPurchaseCost: item.projectPurchaseCost,
        sharedSpend: null,
        reasons: item.reasons,
        trade: item.matchedTrade
          ? (TRADE_LABELS[item.matchedTrade] ?? item.matchedTrade)
          : null,
      })),
    [suggestions],
  );
  const browseRows = useCallback(
    (
      items: NonNullable<typeof toolSearchQuery.data>["items"],
      category: string,
    ) =>
      items
        .filter((item) => !attachedIds.has(item.id))
        .map<PickerRow>((item) => ({
          id: item.id,
          name: item.name,
          manufacturer: item.manufacturer,
          category,
          images: imagesFor(item.id, item.name, item.coverImageUrl),
          uses: 0,
          lifetimeCost: 0,
          costPerUse: null,
          projectPurchaseCost: null,
          sharedSpend: null,
          reasons: [],
          trade: null,
        })),
    [attachedIds],
  );
  const toolRows = useMemo(
    () => browseRows(toolSearchQuery.data?.items ?? [], "Tools"),
    [browseRows, toolSearchQuery.data?.items],
  );
  const softwareRows = useMemo(
    () => browseRows(softwareSearchQuery.data?.items ?? [], "Software"),
    [browseRows, softwareSearchQuery.data?.items],
  );

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setSearch("");
    }
    onOpenChange(next);
  };
  const attachBase = api.project.attachResources.mutationOptions();
  const attach = useMutation({
    mutationKey: attachBase.mutationKey,
    mutationFn: attachBase.mutationFn,
    onMutate: async (variables) => {
      await cancelQueryRoots(queryClient, [resourcesKey]);
      const previous =
        queryClient.getQueryData<ProjectResourceOut[]>(resourcesKey);
      const candidates = [...suggestionRows, ...toolRows, ...softwareRows];
      const optimistic = variables.productIds.map((productId) => {
        const item = candidates.find((candidate) => candidate.id === productId);
        return {
          productId: productId as ProjectResourceOut["productId"],
          productName: item?.name ?? productId,
          manufacturer: item?.manufacturer ?? "",
          category:
            item?.category.toLowerCase() === "software" ? "software" : "tools",
          coverImageUrl: item?.images[0]?.url ?? null,
          attachedAt: new Date(),
          projectPurchaseCost: item?.projectPurchaseCost ?? null,
          sharedWindow: null,
          projectUseCount: item?.uses ?? 0,
          netLifetimeCost: item?.lifetimeCost ?? 0,
          costPerProjectUse: item?.costPerUse ?? null,
          grossLifetimeAcquisitionCost: null,
        } satisfies ProjectResourceOut;
      });
      queryClient.setQueryData<ProjectResourceOut[]>(
        resourcesKey,
        (current) => {
          const ids = new Set((current ?? []).map((item) => item.productId));
          return [
            ...(current ?? []),
            ...optimistic.filter((item) => !ids.has(item.productId)),
          ];
        },
      );
      const previousSelection = new Set(selected);
      setSelected(new Set());
      onOpenChange(false);
      return { previous, previousSelection };
    },
    onSuccess: (result) =>
      toast.success(
        `Attached ${result.changed} resource${result.changed === 1 ? "" : "s"}`,
      ),
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(resourcesKey, context.previous);
      setSelected(context?.previousSelection ?? new Set());
      onOpenChange(true);
      toast.error(getErrorMessage(error));
    },
    onSettled: () =>
      invalidateQueryRoots(queryClient, invalidatesFor("project", "resource")),
  });

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add reusable resources</DialogTitle>
          <DialogDescription>
            Review physical-tool suggestions or browse tool and software
            Products. Attaching records use; it does not change spend or
            inventory.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="suggested">
          <TabsList>
            <TabsTrigger value="suggested">
              Suggested tools
              {suggestions.length > 0 && (
                <Badge variant="outline">{suggestions.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="tools">Browse tools</TabsTrigger>
            <TabsTrigger value="software">Browse software</TabsTrigger>
          </TabsList>
          <TabsContent value="suggested">
            <SelectableResourceTable
              rows={suggestionRows}
              selected={selected}
              setSelected={setSelected}
              isLoading={suggestionsQuery.isPending}
              suggested
              emptyCopy="No suggestions yet. Browse tools to attach one manually."
            />
          </TabsContent>
          {[
            {
              value: "tools",
              placeholder: "Search tool products…",
              rows: toolRows,
              loading: toolSearchQuery.isPending,
            },
            {
              value: "software",
              placeholder: "Search software products…",
              rows: softwareRows,
              loading: softwareSearchQuery.isPending,
            },
          ].map((tab) => (
            <TabsContent key={tab.value} value={tab.value}>
              <Stack gap="sm">
                <Row align="center" gap="sm">
                  <Search
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={tab.placeholder}
                  />
                </Row>
                <SelectableResourceTable
                  rows={tab.rows}
                  selected={selected}
                  setSelected={setSelected}
                  isLoading={tab.loading}
                  suggested={false}
                  emptyCopy={`No unattached ${tab.value} match this search.`}
                />
              </Stack>
            </TabsContent>
          ))}
        </Tabs>
        <DialogFooter showCloseButton>
          <Description size="xs" className="mr-auto">
            {selected.size} selected
          </Description>
          <Button
            type="button"
            disabled={selected.size === 0 || attach.isPending}
            onClick={() =>
              attach.mutate({ projectId, productIds: [...selected] })
            }
          >
            <Plus />
            Attach {selected.size || "selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectResourcesSection({ projectId }: { projectId: string }) {
  const api = useTRPC();
  const [pickerOpen, setPickerOpen] = useState(false);
  const resourcesKey = api.project.resources.queryKey({ projectId });
  const resourcesQuery = useQuery(
    api.project.resources.queryOptions({ projectId }),
  );
  const suggestionsQuery = useQuery(
    api.project.toolSuggestions.queryOptions({ projectId }),
  );
  const resources = resourcesQuery.data ?? EMPTY_RESOURCES;
  const resourceRows = useMemo<ResourceRow[]>(
    () =>
      resources.map((item) => ({
        id: item.productId,
        name: item.productName,
        manufacturer: item.manufacturer,
        category: item.category,
        images: imagesFor(item.productId, item.productName, item.coverImageUrl),
        uses: item.projectUseCount,
        lifetimeCost: item.netLifetimeCost,
        costPerUse: item.costPerProjectUse,
        projectPurchaseCost: item.projectPurchaseCost,
        sharedSpend: item.sharedWindow
          ? `${formatCurrency(item.sharedWindow.netCost)} during ${item.sharedWindow.startDate}–${item.sharedWindow.endDate}`
          : item.category === "software"
            ? "Shared spend unavailable"
            : null,
      })),
    [resources],
  );
  const suggestionCount = suggestionsQuery.data?.items.length ?? 0;
  const unlinked = suggestionsQuery.data?.unlinkedExpensivePurchases;
  const timelineConflicts = suggestionsQuery.data?.timelineConflicts.count ?? 0;
  const attachedIds = useMemo(
    () => new Set(resources.map((resource) => resource.productId)),
    [resources],
  );

  return (
    <Stack gap="sm">
      <Row align="center" justify="between" gap="sm">
        <Description size="xs">
          Explicit uses only; each exact project counts once per resource.
        </Description>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
        >
          <Wrench />
          Add resources
          {suggestionCount > 0 && (
            <Badge variant="outline">{suggestionCount}</Badge>
          )}
        </Button>
      </Row>
      {unlinked && unlinked.count > 0 && (
        <div className="border border-[var(--border)] bg-muted p-4">
          <Description size="xs">
            {unlinked.count} tool purchase{unlinked.count === 1 ? "" : "s"} of
            $100+ ({formatCurrency(unlinked.grossCost)} total) cannot be
            suggested because no Product is linked.{" "}
            <a
              href={`/expenses?project=${encodeURIComponent(projectId)}&costType=tools&future=false&product=none&cost=gte100`}
              className="text-primary underline underline-offset-3"
            >
              Review expenses
            </a>
          </Description>
        </div>
      )}
      {timelineConflicts > 0 && (
        <Description size="xs">
          {timelineConflicts} tool{timelineConflicts === 1 ? "" : "s"} matching
          this project&apos;s trades {timelineConflicts === 1 ? "was" : "were"}{" "}
          hidden because it was not owned while this project ran.
        </Description>
      )}
      <ResourcesTable
        rows={resourceRows}
        projectId={projectId}
        resourcesKey={resourcesKey}
        isLoading={resourcesQuery.isPending}
      />
      <ResourcePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projectId={projectId}
        attachedIds={attachedIds}
        resourcesKey={resourcesKey}
      />
    </Stack>
  );
}
