import {
  type SmartCollectionDefinition,
  type SmartCollectionKey,
  type SmartCollectionRule,
  type SmartCollectionSummary,
} from "@cubby/schemas/collection";
import { TRADE_LABELS, tradeSchema, tradeValues } from "@cubby/schemas/project";
import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { SparkleIcon as Sparkles } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TrashIcon as Trash2 } from "@phosphor-icons/react/dist/csr/Trash";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";

import { CollectionProductsTable } from "./collection-detail-page";
import { collection as collectionOperations } from "./collection.functions";
import {
  getSmartCollectionStarter,
  isStarterDefinition,
  parseSmartCollectionDraft,
  type SmartCollectionDraft,
  type SmartCollectionRuleDraft,
  useSmartCollections,
} from "./smart-collection-state";

const PAGE_SIZE = 50;

const RULE_KIND_LABELS = {
  effectiveOwnerEquals: "Effective owner",
  categoryEquals: "Classification subtree",
  categoryFeatureEquals: "Classification feature",
  productTagEquals: "Product tag equals",
  manufacturerEquals: "Manufacturer equals",
  locationNameContains: "Location or ancestor contains",
  historicalExpenseTrade: "Historical Expense Trade",
} satisfies Record<SmartCollectionRule["kind"], string>;

const RULE_KINDS = [
  "productTagEquals",
  "manufacturerEquals",
  "locationNameContains",
  "historicalExpenseTrade",
] as const satisfies readonly SmartCollectionRule["kind"][];

function isRuleKind(value: string): value is SmartCollectionRule["kind"] {
  return RULE_KINDS.some((kind) => kind === value);
}

export type SmartCollectionOperations = Pick<
  typeof collectionOperations,
  "smartDetail"
>;

function ruleDescription(rule: SmartCollectionRuleDraft): string {
  if (rule.kind === "historicalExpenseTrade") {
    const trade = tradeSchema.safeParse(rule.value);
    return `Historical Expense Trade is ${trade.success ? TRADE_LABELS[trade.data] : rule.value}`;
  }
  if (rule.kind === "locationNameContains") {
    return `Location or ancestor name contains “${rule.value}”`;
  }
  if (rule.kind === "manufacturerEquals") {
    return `Manufacturer is “${rule.value}”`;
  }
  if (rule.kind === "categoryEquals") {
    return `Classification subtree is ${rule.value}`;
  }
  if (rule.kind === "categoryFeatureEquals") {
    return `Classification feature is ${rule.value}`;
  }
  return `Product tag is “${rule.value}”`;
}

function SmartCounts({ summary }: { summary: SmartCollectionSummary }) {
  const sources = [
    ["Tag", summary.sourceCounts.productTagEquals],
    ["Manufacturer", summary.sourceCounts.manufacturerEquals],
    ["Location", summary.sourceCounts.locationNameContains],
    ["Trade", summary.sourceCounts.historicalExpenseTrade],
  ] as const;

  return (
    <div className="grid grid-cols-2 border-y border-border sm:grid-cols-5">
      <div className="col-span-2 border-b border-border px-3 py-2 sm:col-span-1 sm:border-r sm:border-b-0">
        <div className="font-mono text-lg font-medium tabular-nums">
          {summary.totalCount}
        </div>
        <div className="text-2xs text-muted-foreground">Distinct products</div>
      </div>
      {sources.map(([label, count], index) => (
        <div
          key={label}
          className={`px-3 py-2 ${index % 2 === 0 ? "border-r border-border" : ""} ${index < 2 ? "border-b border-border sm:border-b-0" : ""} sm:border-r sm:border-border last:sm:border-r-0`}
        >
          <div className="font-mono text-sm font-medium tabular-nums">
            {count}
          </div>
          <div className="text-2xs text-muted-foreground">{label}</div>
        </div>
      ))}
      <p className="col-span-2 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground sm:col-span-5">
        Source counts overlap when a Product matches more than one rule.
      </p>
    </div>
  );
}

function ruleDefault(kind: SmartCollectionRule["kind"]): string {
  return kind === "historicalExpenseTrade" ? "finishes" : "";
}

function SmartRuleEditor({
  starter,
  draft,
  updateDraft,
  onReset,
}: {
  starter: SmartCollectionDefinition;
  draft: SmartCollectionDraft;
  updateDraft: (next: SmartCollectionDraft) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newKind, setNewKind] = useState<SmartCollectionRule["kind"]>(
    "locationNameContains",
  );
  const nameId = useId();
  const parsed = parseSmartCollectionDraft(draft);
  const changed = !isStarterDefinition(draft);
  const errorAt = (path: (string | number)[]) =>
    parsed.success
      ? undefined
      : parsed.error.issues.find(
          (issue) => JSON.stringify(issue.path) === JSON.stringify(path),
        )?.message;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-y border-border bg-muted/20">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
              Edit temporary rules
              <ChevronDown
                className={`transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden
              />
            </CollapsibleTrigger>
            {changed && <Badge variant="secondary">Temporary changes</Badge>}
            {!parsed.success && (
              <span className="text-xs text-destructive">
                Preview uses the last valid rules
              </span>
            )}
          </div>
          {changed && (
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw aria-hidden /> Reset to starter
            </Button>
          )}
        </div>

        <CollapsibleContent>
          <div className="space-y-4 border-t border-border bg-card px-3 py-4">
            <div className="max-w-lg space-y-1">
              <label htmlFor={nameId} className="text-xs font-medium">
                Collection name
              </label>
              <Input
                id={nameId}
                value={draft.name}
                aria-invalid={Boolean(errorAt(["name"]))}
                onChange={(event) =>
                  updateDraft({ ...draft, name: event.target.value })
                }
              />
              {errorAt(["name"]) && (
                <p className="text-xs text-destructive">{errorAt(["name"])}</p>
              )}
            </div>

            <div className="space-y-2">
              <div>
                <h3 className="text-xs font-semibold">Match any condition</h3>
                <p className="text-xs text-muted-foreground">
                  A Product appears when at least one condition has recorded
                  evidence.
                </p>
              </div>
              {draft.rules.length === 0 ? (
                <p className="border-y border-border py-3 text-xs text-muted-foreground">
                  No conditions. This Collection matches no Products.
                </p>
              ) : (
                <div className="divide-y divide-border border-y border-border">
                  {draft.rules.map((rule, index) => {
                    const valueError = errorAt(["rules", index, "value"]);
                    return (
                      <div
                        key={rule.id}
                        className="grid gap-2 py-2 md:grid-cols-[14rem_minmax(12rem,1fr)_auto] md:items-start"
                      >
                        <NativeSelect
                          aria-label={`Condition ${index + 1} type`}
                          value={rule.kind}
                          onChange={(event) => {
                            const kind = event.target.value;
                            if (!isRuleKind(kind)) return;
                            const rules = draft.rules.slice();
                            rules[index] = {
                              id: rule.id,
                              kind,
                              value: ruleDefault(kind),
                            };
                            updateDraft({ ...draft, rules });
                          }}
                        >
                          {RULE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {RULE_KIND_LABELS[kind]}
                            </option>
                          ))}
                        </NativeSelect>
                        <div>
                          {rule.kind === "historicalExpenseTrade" ? (
                            <NativeSelect
                              aria-label={`Condition ${index + 1} value`}
                              value={rule.value}
                              onChange={(event) => {
                                const trade = tradeSchema.safeParse(
                                  event.target.value,
                                );
                                if (!trade.success) return;
                                const rules = draft.rules.slice();
                                rules[index] = {
                                  ...rule,
                                  value: trade.data,
                                };
                                updateDraft({ ...draft, rules });
                              }}
                            >
                              {tradeValues.map((trade) => (
                                <option key={trade} value={trade}>
                                  {TRADE_LABELS[trade]}
                                </option>
                              ))}
                            </NativeSelect>
                          ) : (
                            <Input
                              aria-label={`Condition ${index + 1} value`}
                              value={rule.value}
                              aria-invalid={Boolean(valueError)}
                              onChange={(event) => {
                                const rules = draft.rules.slice();
                                rules[index] = {
                                  ...rule,
                                  value: event.target.value,
                                };
                                updateDraft({ ...draft, rules });
                              }}
                            />
                          )}
                          {valueError && (
                            <p className="mt-1 text-xs text-destructive">
                              {valueError}
                            </p>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove condition ${index + 1}`}
                          onClick={() =>
                            updateDraft({
                              ...draft,
                              rules: draft.rules.filter(
                                (_, ruleIndex) => ruleIndex !== index,
                              ),
                            })
                          }
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  className="w-auto min-w-56"
                  aria-label="New condition type"
                  value={newKind}
                  onChange={(event) =>
                    isRuleKind(event.target.value) &&
                    setNewKind(event.target.value)
                  }
                >
                  {RULE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {RULE_KIND_LABELS[kind]}
                    </option>
                  ))}
                </NativeSelect>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    updateDraft({
                      ...draft,
                      rules: [
                        ...draft.rules,
                        {
                          id: crypto.randomUUID(),
                          kind: newKind,
                          value: ruleDefault(newKind),
                        },
                      ],
                    })
                  }
                  disabled={draft.rules.length >= 20}
                >
                  <Plus aria-hidden /> Add condition
                </Button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Edits reset when you refresh. The starter “{starter.name}” is
              never changed.
            </p>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function SmartCollectionPage({
  starterKey,
  search,
  page,
  onSearchChange,
  operations = collectionOperations,
}: {
  starterKey: SmartCollectionKey;
  search?: string;
  page: number;
  onSearchChange: (next: { q?: string; page?: number }) => void;
  operations?: SmartCollectionOperations;
}) {
  const productsHeadingId = useId();
  const { drafts, validDefinitions, updateDraft, reset } =
    useSmartCollections();
  const draft = drafts[starterKey];
  const definition = validDefinitions[starterKey];
  const starter = getSmartCollectionStarter(starterKey);
  const result = useQuery(
    operations.smartDetail.queryOptions({
      definition,
      search,
      pagination: { pageIndex: page - 1, pageSize: PAGE_SIZE },
    }),
  );

  return (
    <Stack gap="lg">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <Badge variant="outline">Dynamic</Badge>
          <span className="text-xs text-muted-foreground">
            Membership updates from current records
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {draft.rules.length ? (
            draft.rules.map((rule, index) => (
              <span key={rule.id}>
                {index > 0 && <span aria-hidden>or </span>}
                {ruleDescription(rule)}
              </span>
            ))
          ) : (
            <span>No matching conditions</span>
          )}
        </div>
      </div>

      <SmartRuleEditor
        starter={starter}
        draft={draft}
        updateDraft={(next) => {
          updateDraft(starterKey, () => next);
          onSearchChange({ page: 1 });
        }}
        onReset={() => {
          reset(starterKey);
          onSearchChange({ page: 1 });
        }}
      />

      {result.isLoading ? (
        <div className="space-y-3" aria-label="Loading smart Collection">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : result.error ? (
        <div className="border-y border-destructive/40 py-8 text-center">
          <p className="font-medium text-destructive">
            Could not preview this Collection
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.error.message}
          </p>
        </div>
      ) : result.data ? (
        <>
          <SmartCounts summary={result.data.summary} />
          <section aria-labelledby={productsHeadingId}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id={productsHeadingId} className="text-sm font-semibold">
                {definition.name} products
              </h2>
              <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                {result.data.totalCount} total
              </span>
            </div>
            <CollectionProductsTable
              products={result.data.products}
              totalCount={result.data.totalCount}
              search={search}
              page={page}
              onSearchChange={onSearchChange}
            />
          </section>
        </>
      ) : null}
    </Stack>
  );
}
