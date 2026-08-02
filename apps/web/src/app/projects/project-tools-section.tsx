import type {
  ProjectToolOut,
  ProjectToolSuggestionOut,
} from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Trash2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
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
import { projectToolMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";

function economicsLabel(tool: {
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

function ToolIdentity({
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

function AttachedToolRow({
  projectId,
  tool,
}: {
  projectId: string;
  tool: ProjectToolOut;
}) {
  const api = useTRPC();
  const detach = useActionMutation({
    mutationFn: api.project.detachTools.mutationOptions,
    success: `Removed ${tool.productName} from this project`,
    invalidateKeys: projectToolMutationInvalidateKeys,
  });

  return (
    <Row
      align="center"
      justify="between"
      gap="md"
      className="border border-[var(--border)] p-4"
    >
      <Stack gap="xs" className="min-w-0">
        <ToolIdentity
          id={tool.productId}
          name={tool.productName}
          manufacturer={tool.manufacturer}
        />
        <Description size="xs">{economicsLabel(tool)}</Description>
        {tool.projectPurchaseCost > 0 && (
          <Badge variant="outline" className="w-fit">
            {formatCurrency(tool.projectPurchaseCost)} bought here
          </Badge>
        )}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${tool.productName} from this project`}
        disabled={detach.isPending}
        onClick={() =>
          detach.mutate({ projectId, productIds: [tool.productId] })
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
        <ToolIdentity
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
        <Description size="xs">{economicsLabel(suggestion)}</Description>
      </Stack>
    </Row>
  );
}

function ToolPickerDialog({
  open,
  onOpenChange,
  projectId,
  attachedIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  attachedIds: Set<string>;
}) {
  const api = useTRPC();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const suggestionsQuery = useQuery(
    api.project.toolSuggestions.queryOptions({ projectId }, { enabled: open }),
  );
  const searchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search, categoryFilter: "tools" },
      pagination: { pageIndex: 0, pageSize: 50 },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const suggestions = suggestionsQuery.data?.items ?? [];
  const purchasedHere = suggestions.filter(
    (suggestion) => suggestion.lane === "purchased_here",
  );
  const tradeMatches = suggestions.filter(
    (suggestion) => suggestion.lane === "trade_match",
  );
  const browseItems = (searchQuery.data?.items ?? []).filter(
    (item) => !attachedIds.has(item.id),
  );

  const attach = useActionMutation({
    mutationFn: api.project.attachTools.mutationOptions,
    success: (result) =>
      `Attached ${result.changed} tool${result.changed === 1 ? "" : "s"}`,
    invalidateKeys: projectToolMutationInvalidateKeys,
    onSuccess: () => {
      setSelected(new Set());
      onOpenChange(false);
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
    for (const suggestion of tradeMatches) {
      const key = suggestion.matchedTrade ?? "other";
      groups.set(key, [...(groups.get(key) ?? []), suggestion]);
    }
    return [...groups.entries()];
  }, [tradeMatches]);

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
          <DialogTitle>Add tools used on this project</DialogTitle>
          <DialogDescription>
            Review suggestions or browse all Cubby tool products. Attaching a
            tool records reuse; it does not change project spend or inventory.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="suggested">
          <TabsList>
            <TabsTrigger value="suggested">
              Suggested
              {suggestions.length > 0 && (
                <Badge variant="outline">{suggestions.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="browse">Browse tools</TabsTrigger>
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

          <TabsContent value="browse">
            <Stack gap="sm">
              <Row align="center" gap="sm">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tool products…"
                />
              </Row>
              {searchQuery.isPending ? (
                <Description>Loading tools…</Description>
              ) : browseItems.length === 0 ? (
                <Description>
                  No unattached tools match this search.
                </Description>
              ) : (
                <Stack gap="xs" className="max-h-96 overflow-y-auto">
                  {browseItems.map((item) => (
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
                      <ToolIdentity
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

export function ProjectToolsSection({ projectId }: { projectId: string }) {
  const api = useTRPC();
  const [pickerOpen, setPickerOpen] = useState(false);
  const toolsQuery = useQuery(api.project.tools.queryOptions({ projectId }));
  const suggestionsQuery = useQuery(
    api.project.toolSuggestions.queryOptions({ projectId }),
  );
  const tools = toolsQuery.data ?? [];
  const suggestionCount = suggestionsQuery.data?.items.length ?? 0;
  const unlinked = suggestionsQuery.data?.unlinkedExpensivePurchases;
  const attachedIds = useMemo(
    () => new Set(tools.map((tool) => tool.productId)),
    [tools],
  );

  return (
    <Stack gap="sm">
      <Row align="center" justify="between" gap="sm">
        <Description size="xs">
          Explicit uses only; each exact project counts once per tool.
        </Description>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
        >
          <Wrench />
          Add tools
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

      {toolsQuery.isPending ? (
        <Description>Loading tools…</Description>
      ) : tools.length === 0 ? (
        <Empty variant="minimal" className="py-6">
          <EmptyHeader>
            <EmptyTitle>No tools recorded</EmptyTitle>
            <EmptyDescription>
              Add only the meaningful durable tools. Small consumables do not
              need to become project-use records.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Stack gap="xs">
          {tools.map((tool) => (
            <AttachedToolRow
              key={tool.productId}
              projectId={projectId}
              tool={tool}
            />
          ))}
        </Stack>
      )}

      <ToolPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projectId={projectId}
        attachedIds={attachedIds}
      />
    </Stack>
  );
}
