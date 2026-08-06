import type {
  ProjectResourceOut,
  ProjectToolSuggestionOut,
} from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { Separator } from "~/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  cancelTRPCQueries,
  invalidateTRPCQueries,
  projectResourceMutationInvalidateKeys,
} from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";

const EMPTY_RESOURCES: ProjectResourceOut[] = [];
const EMPTY_SUGGESTIONS: ProjectToolSuggestionOut[] = [];

function toolEconomicsLabel(tool: {
  projectUseCount: number;
  netLifetimeCost: number;
  costPerProjectUse: number | null;
}) {
  const uses = `${tool.projectUseCount} project use${tool.projectUseCount === 1 ? "" : "s"}`;
  const lifetime = `${formatCurrency(tool.netLifetimeCost)} net lifetime cost`;
  const perUse =
    tool.costPerProjectUse === null
      ? "cost/use pending"
      : `${formatCurrency(tool.costPerProjectUse)} per use`;
  return `${uses} · ${lifetime} · ${perUse}`;
}

function ResourceIdentity({
  id,
  name,
  manufacturer,
}: {
  id: string;
  name: string;
  manufacturer: string;
}) {
  return (
    <div className="min-w-0">
      <EntityInlineLink
        entity="product"
        data={{ id, name, manufacturer }}
        truncate
      />
    </div>
  );
}

function AttachedResourceRow({
  projectId,
  resource,
  resourcesKey,
}: {
  projectId: string;
  resource: ProjectResourceOut;
  resourcesKey: QueryKey;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const detachBase = api.project.detachResources.mutationOptions();
  const detach = useMutation({
    mutationKey: detachBase.mutationKey,
    mutationFn: detachBase.mutationFn,
    onMutate: async (variables) => {
      await cancelTRPCQueries(queryClient, [resourcesKey]);
      const previous =
        queryClient.getQueryData<ProjectResourceOut[]>(resourcesKey);
      queryClient.setQueryData<ProjectResourceOut[]>(resourcesKey, (current) =>
        current?.filter(
          (item) => !variables.productIds.includes(item.productId),
        ),
      );
      return { previous };
    },
    onSuccess: () =>
      toast.success(`Removed ${resource.productName} from this project`),
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(resourcesKey, context.previous);
      toast.error(getErrorMessage(error));
    },
    onSettled: () =>
      invalidateTRPCQueries(queryClient, projectResourceMutationInvalidateKeys),
  });

  return (
    <Row
      align="center"
      justify="between"
      gap="md"
      className="border border-[var(--border)] p-4"
    >
      <Stack gap="xs" className="min-w-0">
        <ResourceIdentity
          id={resource.productId}
          name={resource.productName}
          manufacturer={resource.manufacturer}
        />
        <Description size="xs">
          {resource.category === "tools"
            ? toolEconomicsLabel(resource)
            : `${resource.projectUseCount} project use${resource.projectUseCount === 1 ? "" : "s"} · ${formatCurrency(resource.netLifetimeCost)} lifetime household spend`}
        </Description>
        {resource.category === "tools" &&
          resource.projectPurchaseCost !== null &&
          resource.projectPurchaseCost > 0 && (
            <Badge variant="outline" className="w-fit">
              {formatCurrency(resource.projectPurchaseCost)} bought here
            </Badge>
          )}
        {resource.category === "software" && resource.sharedWindow && (
          <Description size="xs">
            {formatCurrency(resource.sharedWindow.netCost)} shared spend during
            project ({resource.sharedWindow.startDate}–
            {resource.sharedWindow.endDate}); contextual and non-additive
          </Description>
        )}
        {resource.category === "software" && !resource.sharedWindow && (
          <Description size="xs">
            Shared project-window spend is unavailable until the project has a
            valid date window.
          </Description>
        )}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${resource.productName} from this project`}
        disabled={detach.isPending}
        onClick={() =>
          detach.mutate({ projectId, productIds: [resource.productId] })
        }
      >
        <Trash2 />
      </Button>
    </Row>
  );
}

function SuggestionRow({
  suggestion,
  checked,
  onCheckedChange,
}: {
  suggestion: ProjectToolSuggestionOut;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Row
      as="label"
      align="start"
      gap="sm"
      className="cursor-pointer border border-[var(--border)] p-4"
    >
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
      <Stack gap="xs" className="min-w-0 flex-1">
        <ResourceIdentity
          id={suggestion.productId}
          name={suggestion.productName}
          manufacturer={suggestion.manufacturer}
        />
        <Row wrap gap="xs">
          {suggestion.reasons.map((reason) => (
            <Badge key={reason} variant="outline">
              {reason}
            </Badge>
          ))}
        </Row>
        <Description size="xs">{toolEconomicsLabel(suggestion)}</Description>
      </Stack>
    </Row>
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
      filters: { nameFilter: search, categoryFilter: "tools" },
      pagination: { pageIndex: 0, pageSize: 50 },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const softwareSearchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search, categoryFilter: "software" },
      pagination: { pageIndex: 0, pageSize: 50 },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const suggestions = suggestionsQuery.data?.items ?? EMPTY_SUGGESTIONS;
  const purchasedHere = suggestions.filter(
    (suggestion) => suggestion.lane === "purchased_here",
  );
  const browseTools = (toolSearchQuery.data?.items ?? []).filter(
    (item) => !attachedIds.has(item.id),
  );
  const browseSoftware = (softwareSearchQuery.data?.items ?? []).filter(
    (item) => !attachedIds.has(item.id),
  );

  const attachBase = api.project.attachResources.mutationOptions();
  const attach = useMutation({
    mutationKey: attachBase.mutationKey,
    mutationFn: attachBase.mutationFn,
    onMutate: async (variables) => {
      await cancelTRPCQueries(queryClient, [resourcesKey]);
      const previous =
        queryClient.getQueryData<ProjectResourceOut[]>(resourcesKey);
      const browsed = [
        ...(toolSearchQuery.data?.items ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          manufacturer: item.manufacturer ?? "",
          category: "tools" as const,
        })),
        ...(softwareSearchQuery.data?.items ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          manufacturer: item.manufacturer ?? "",
          category: "software" as const,
        })),
      ];
      const selectedSuggestions = suggestions.filter((item) =>
        variables.productIds.includes(item.productId),
      );
      const optimistic = variables.productIds.map((productId) => {
        const typedProductId = productId as ProjectResourceOut["productId"];
        const suggestion = selectedSuggestions.find(
          (item) => item.productId === productId,
        );
        const product = browsed.find((item) => item.id === productId);
        return {
          productId: typedProductId,
          productName: suggestion?.productName ?? product?.name ?? productId,
          manufacturer: suggestion?.manufacturer ?? product?.manufacturer ?? "",
          category: product?.category ?? ("tools" as const),
          attachedAt: new Date(),
          projectPurchaseCost: suggestion?.projectPurchaseCost ?? null,
          sharedWindow: null,
          projectUseCount: suggestion?.projectUseCount ?? 0,
          netLifetimeCost: suggestion?.netLifetimeCost ?? 0,
          costPerProjectUse: suggestion?.costPerProjectUse ?? null,
          grossLifetimeAcquisitionCost:
            suggestion?.grossLifetimeAcquisitionCost ?? null,
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
    onSuccess: (result) => {
      toast.success(
        `Attached ${result.changed} resource${result.changed === 1 ? "" : "s"}`,
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(resourcesKey, context.previous);
      setSelected(context?.previousSelection ?? new Set());
      onOpenChange(true);
      toast.error(getErrorMessage(error));
    },
    onSettled: () => {
      invalidateTRPCQueries(queryClient, projectResourceMutationInvalidateKeys);
    },
  });

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const tradeGroups = useMemo(() => {
    const groups = new Map<string, ProjectToolSuggestionOut[]>();
    for (const suggestion of suggestions) {
      if (suggestion.lane !== "trade_match") continue;
      const key = suggestion.matchedTrade ?? "other";
      groups.set(key, [...(groups.get(key) ?? []), suggestion]);
    }
    return [...groups.entries()];
  }, [suggestions]);

  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setSearch("");
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add reusable resources</DialogTitle>
          <DialogDescription>
            Review physical-tool suggestions or browse tool and software
            Products. Attaching a resource records use; it does not change
            project spend, budgets, or inventory.
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
            {suggestionsQuery.isPending ? (
              <Description>Finding likely tools…</Description>
            ) : suggestions.length === 0 ? (
              <Empty variant="minimal" className="py-8">
                <EmptyHeader>
                  <EmptyTitle>No suggestions yet</EmptyTitle>
                  <EmptyDescription>
                    Browse tools to attach one manually. Future suggestions
                    learn from explicit reuse and the project&apos;s trades.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Stack gap="md">
                {purchasedHere.length > 0 && (
                  <Stack gap="xs">
                    <p className="eyebrow my-0">Purchased for this project</p>
                    {purchasedHere.map((suggestion) => (
                      <SuggestionRow
                        key={suggestion.productId}
                        suggestion={suggestion}
                        checked={selected.has(suggestion.productId)}
                        onCheckedChange={(checked) =>
                          toggle(suggestion.productId, checked)
                        }
                      />
                    ))}
                  </Stack>
                )}
                {purchasedHere.length > 0 && tradeGroups.length > 0 && (
                  <Separator />
                )}
                {tradeGroups.map(([trade, rows]) => (
                  <Stack key={trade} gap="xs">
                    <p className="eyebrow my-0">
                      {TRADE_LABELS[trade as keyof typeof TRADE_LABELS] ??
                        trade}
                    </p>
                    {rows.map((suggestion) => (
                      <SuggestionRow
                        key={suggestion.productId}
                        suggestion={suggestion}
                        checked={selected.has(suggestion.productId)}
                        onCheckedChange={(checked) =>
                          toggle(suggestion.productId, checked)
                        }
                      />
                    ))}
                  </Stack>
                ))}
              </Stack>
            )}
          </TabsContent>

          <TabsContent value="tools">
            <Stack gap="sm">
              <Row align="center" gap="sm">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tool products…"
                />
              </Row>
              {toolSearchQuery.isPending ? (
                <Description>Loading tools…</Description>
              ) : browseTools.length === 0 ? (
                <Description>
                  No unattached tools match this search.
                </Description>
              ) : (
                <Stack gap="xs" className="max-h-96 overflow-y-auto">
                  {browseTools.map((item) => (
                    <Row
                      as="label"
                      key={item.id}
                      align="center"
                      gap="sm"
                      className="cursor-pointer border border-[var(--border)] p-4"
                    >
                      <Checkbox
                        checked={selected.has(item.id)}
                        onCheckedChange={(checked) => toggle(item.id, checked)}
                      />
                      <ResourceIdentity
                        id={item.id}
                        name={item.name}
                        manufacturer={item.manufacturer}
                      />
                    </Row>
                  ))}
                </Stack>
              )}
            </Stack>
          </TabsContent>

          <TabsContent value="software">
            <Stack gap="sm">
              <Row align="center" gap="sm">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search software products…"
                />
              </Row>
              {softwareSearchQuery.isPending ? (
                <Description>Loading software…</Description>
              ) : browseSoftware.length === 0 ? (
                <Description>
                  No unattached software matches this search.
                </Description>
              ) : (
                <Stack gap="xs" className="max-h-96 overflow-y-auto">
                  {browseSoftware.map((item) => (
                    <Row
                      as="label"
                      key={item.id}
                      align="center"
                      gap="sm"
                      className="cursor-pointer border border-[var(--border)] p-4"
                    >
                      <Checkbox
                        checked={selected.has(item.id)}
                        onCheckedChange={(checked) => toggle(item.id, checked)}
                      />
                      <ResourceIdentity
                        id={item.id}
                        name={item.name}
                        manufacturer={item.manufacturer}
                      />
                    </Row>
                  ))}
                </Stack>
              )}
            </Stack>
          </TabsContent>
        </Tabs>

        <DialogFooter showCloseButton>
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
          this project&rsquo;s trades {timelineConflicts === 1 ? "was" : "were"}{" "}
          hidden — we didn&rsquo;t own {timelineConflicts === 1 ? "it" : "them"}{" "}
          while this project ran.
        </Description>
      )}

      {resourcesQuery.isPending ? (
        <Description>Loading reusable resources…</Description>
      ) : resources.length === 0 ? (
        <Empty variant="minimal" className="py-6">
          <EmptyHeader>
            <EmptyTitle>No reusable resources recorded</EmptyTitle>
            <EmptyDescription>
              Add meaningful durable tools and shared software. Small
              consumables do not need to become project-use records.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Stack gap="xs">
          {resources.map((resource) => (
            <AttachedResourceRow
              key={resource.productId}
              projectId={projectId}
              resource={resource}
              resourcesKey={resourcesKey}
            />
          ))}
        </Stack>
      )}

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
