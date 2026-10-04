import {
  parseShortcodeFor,
  type PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  costTypeSchema,
  type ExpenseOut,
  tradeSchema,
} from "@cubby/schemas/project";
import {
  type SplitPartDraft,
  purchaseSplitCheckInput,
  type purchaseSplitCheckOut,
  splitAttributionPolicy,
} from "@cubby/schemas/purchase";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import type { z } from "zod";

import { tradeOptions } from "~/app/projects/trade-options";
import { entityDetailLink } from "~/entity/entities";
import { fieldEnumOptions } from "~/entity/enum-field-display";
import { FieldSuggestionApply } from "~/features/ai/field-suggestion-apply";
import { purchase } from "~/integrations/tanstack-query/generated/catalog.gen";
import { countLabel } from "~/lib/pluralize";
import { formatCurrency } from "~/lib/utils";
import { EntityPicker } from "~/ui/combobox/entity-picker";
import { StaticPicker } from "~/ui/combobox/static-picker";
import { useEntityListSource } from "~/ui/combobox/with-search-hook";
import { WorkflowDialog } from "~/ui/dialogs/workflow-dialog";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { Input } from "~/ui/primitives/input";
import { NoneValue } from "~/ui/primitives/none-value";
import { StatusText } from "~/ui/primitives/status-text";

import { useActionMutation } from "../../ui/hooks/useActionMutation";

/** A part being drafted, with the key React tracks it by. */
type PartDraft = SplitPartDraft & { key: string };

const ATTRIBUTION_OPTIONS = [
  { value: "inherit", label: "Parts inherit the household attribution" },
  { value: "clear", label: "Clear the household attribution" },
] as const;

/**
 * A part's project picker, extracted so `useEntityListSource` (a hook) is
 * called once per part's own component instance rather than inside the
 * parts' `.map()`.
 */
function PartProjectPicker({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange: (projectId: string) => void;
}) {
  const { dialog, items, onSearchChange, isLoading, onOpenChange } =
    useEntityListSource("project");
  const selectedId = projectId ? parseShortcodeFor("project", projectId) : null;
  const selected = selectedId
    ? (items.find((item) => item.id === selectedId) ?? {
        id: selectedId,
        shortcode: selectedId,
        name: selectedId,
      })
    : null;
  return (
    <>
      {dialog}
      <EntityPicker
        entity="project"
        label="project"
        items={items}
        value={selected}
        setValue={(item) => onChange(item?.id ?? "")}
        onSearchChange={onSearchChange}
        isLoading={isLoading}
        onOpenChange={onOpenChange}
        placeholder="No project"
        clearable
      />
    </>
  );
}

/** One part being edited; every change goes up as a patch to the draft. */
function SplitPartCard({
  part,
  index,
  canRemove,
  offersProduct,
  productLabel,
  vendor,
  onChange,
  onKeepProduct,
  onRemove,
}: {
  part: SplitPartDraft;
  index: number;
  canRemove: boolean;
  offersProduct: boolean;
  productLabel: string;
  vendor: string | null;
  onChange: (patch: Partial<SplitPartDraft>) => void;
  onKeepProduct: (keep: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <Stack gap="xs" className="border border-[var(--border)] p-2">
      <Row align="center" justify="between" gap="sm">
        <Eyebrow>Part {index + 1}</Eyebrow>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canRemove}
          onClick={onRemove}
          aria-label={`Remove part ${index + 1}`}
        >
          <XIcon />
        </Button>
      </Row>
      <Row align="center" gap="sm">
        <Input
          value={part.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="What this part is"
          className="flex-1"
          aria-label={`Part ${index + 1} name`}
        />
        <Input
          value={part.cost}
          onChange={(event) => onChange({ cost: event.target.value })}
          type="number"
          step="0.01"
          placeholder="0.00"
          className="w-28 shrink-0 text-right font-mono tabular-nums"
          aria-label={`Part ${index + 1} cost`}
        />
      </Row>
      <Row align="center" gap="sm" wrap>
        <StaticPicker
          items={fieldEnumOptions("expense", "costType")}
          value={part.costType}
          onValueChange={(next) => {
            // Required enum — a cleared picker is a no-op.
            const parsed = costTypeSchema.safeParse(next);
            if (parsed.success) {
              onChange({ costType: parsed.data });
            }
          }}
          className="w-36"
          label={`Part ${index + 1} cost type`}
          compact
        />
        <StaticPicker
          items={tradeOptions}
          value={part.trade}
          onValueChange={(next) => {
            const parsed = tradeSchema.nullable().safeParse(next);
            if (parsed.success) {
              onChange({ trade: parsed.data });
            }
          }}
          className="w-40"
          label={`Part ${index + 1} trade`}
          placeholder="Inherited trade"
          clearable
          compact
        />
        <div className="w-48">
          <PartProjectPicker
            projectId={part.projectId}
            onChange={(projectId) => onChange({ projectId })}
          />
        </div>
        {offersProduct && (
          <Row align="center" gap="xs">
            <Row
              as="label"
              align="center"
              gap="xs"
              className="text-xs"
              title={`Give this part the ${productLabel} link`}
            >
              <Checkbox
                checked={part.keepProduct}
                onCheckedChange={(checked) => onKeepProduct(checked === true)}
                aria-label={`Give part ${index + 1} the ${productLabel} link`}
              />
              Product
            </Row>
            {part.keepProduct ? (
              <Input
                value={part.productQuantity}
                onChange={(event) =>
                  onChange({
                    productQuantity: event.target.value,
                  })
                }
                type="number"
                step="any"
                placeholder="Qty unknown"
                className="w-28"
                aria-label={`Part ${index + 1} product quantity`}
              />
            ) : null}
          </Row>
        )}
      </Row>
      <FieldSuggestionApply
        source={{
          basisMode: "provided",
          entity: "expense",
          targets: ["trade"],
          basis: {
            name: part.name || null,
            projectId: part.projectId || null,
            vendor,
          },
        }}
        currentValue={part.trade}
        onApply={(suggestion) => {
          const parsed = tradeSchema.safeParse(suggestion.value);
          if (parsed.success) {
            onChange({ trade: parsed.data });
          }
        }}
      />
    </Stack>
  );
}

const bare = (part: PartDraft): SplitPartDraft => ({
  name: part.name,
  cost: part.cost,
  costType: part.costType,
  trade: part.trade,
  projectId: part.projectId,
  keepProduct: part.keepProduct,
  productQuantity: part.productQuantity,
});

/**
 * The draft: the server's starting parts, what is typed over them, and the server's live answer
 * about what is typed (`purchase.checkSplit`). Nothing here knows what makes parts valid.
 */
function useSplitDraft(expense: ExpenseOut, open: boolean) {
  const keyCounter = useRef(0);
  const nextKey = () => `part-${keyCounter.current++}`;

  const start = useQuery({
    ...purchase.splitStart.queryOptions({ expenseId: expense.id }),
    enabled: open,
    // A starting point, not live data: refetching mid-edit must not reseed the form.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [edited, setEdited] = useState<PartDraft[] | null>(null);
  const seeded = useMemo<PartDraft[] | null>(
    () =>
      start.data
        ? start.data.parts.map((part) => ({ ...part, key: nextKey() }))
        : null,
    [start.data],
  );
  const parts = edited ?? seeded ?? [];
  const [attributionPolicy, setAttributionPolicy] = useState<
    "inherit" | "clear" | undefined
  >(undefined);

  const edit = (update: (previous: PartDraft[]) => PartDraft[]) =>
    setEdited(update(parts));
  const maxParts = start.data?.maxParts ?? 0;

  // One primitive key for the whole draft, so an idle dialog never re-renders on a fresh array.
  const draftKey = JSON.stringify({
    expenseId: expense.id,
    attributionPolicy,
    parts: parts.map(bare),
  });
  const [settledKey] = useDebouncedValue(draftKey, { wait: 250 });
  const settled = useMemo(
    () => purchaseSplitCheckInput.parse(JSON.parse(settledKey)),
    [settledKey],
  );
  const check = useQuery({
    ...purchase.checkSplit.queryOptions(settled),
    enabled: open && parts.length > 0,
    placeholderData: keepPreviousData,
  });

  return {
    start,
    check,
    parts,
    maxParts,
    attributionPolicy,
    setAttributionPolicy,
    updatePart: (key: string, patch: Partial<SplitPartDraft>) =>
      edit((previous) =>
        previous.map((part) =>
          part.key === key ? { ...part, ...patch } : part,
        ),
      ),
    // At most one part inherits the product link, so setting it clears the others.
    setProductPart: (key: string, keep: boolean) =>
      edit((previous) =>
        previous.map((part) => ({
          ...part,
          keepProduct: keep && part.key === key,
          productQuantity: keep && part.key === key ? part.productQuantity : "",
        })),
      ),
    addPart: () =>
      edit((previous) => {
        // A new part starts like the server's empty second part: the original's type, trade and
        // project, no name, no cost, no product.
        const template = start.data?.parts[1];
        return !template || previous.length >= maxParts
          ? previous
          : [...previous, { ...template, key: nextKey() }];
      }),
    removePart: (key: string) =>
      edit((previous) =>
        previous.length <= 2
          ? previous
          : previous.filter((part) => part.key !== key),
      ),
    reset: () => {
      setEdited(null);
      setAttributionPolicy(undefined);
    },
  };
}

/** The totals under the parts, as the server worded them. */
function SplitTotals({
  result,
  originalCost,
}: {
  result: z.output<typeof purchaseSplitCheckOut> | undefined;
  originalCost: number | null | undefined;
}) {
  return (
    <Stack gap="tight" className="border-t border-[var(--border)] pt-2">
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm text-muted-foreground">Parts total</span>
        <span className="font-mono text-sm tabular-nums">
          {result ? formatCurrency(result.partsTotal) : <NoneValue />}
        </span>
      </Row>
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm text-muted-foreground">Original cost</span>
        <span className="font-mono text-sm tabular-nums">
          {originalCost != null ? formatCurrency(originalCost) : <NoneValue />}
        </span>
      </Row>
      {result ? (
        result.delta !== null && result.delta !== 0 ? (
          <StatusText tone="warning" className="text-xs">
            {result.note}
          </StatusText>
        ) : (
          <Description size="xs">{result.note}</Description>
        )
      ) : null}
      {result?.reason ? (
        <Description size="xs">{result.reason}</Description>
      ) : null}
    </Stack>
  );
}

/**
 * Split one expense into real rows — the replacement for the
 * `(combo, saw portion)` naming convention that encoded splits in 12 row names.
 *
 * Everything this dialog says or decides is the server's: the starting parts and the wording
 * (`purchase.splitStart`), and whether the typed parts can be saved — a name each, whole cents
 * that add up to the original exactly, one product part, an attribution choice
 * (`purchase.checkSplit`). The save sends the body that check returns, and the write validates
 * again. Each part keeps its OWN trade and cost type, which is the point: a combo kit is one
 * Purchase whose saw half is `tools` and whose blade half is `materials`.
 */
export function SplitExpenseDialog({
  open,
  onOpenChange,
  expense,
  purchaseShortcode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: ExpenseOut;
  /**
   * The Purchase the parts get filed under, as its public id. Required, not
   * derived: the caller gates the whole action on the expense having one (the server leaves the
   * verb unavailable with its reason). Also the post-split redirect target.
   */
  purchaseShortcode: PurchaseShortcode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const draft = useSplitDraft(expense, open);
  const { start, check, parts, attributionPolicy } = draft;
  const [saveError, setSaveError] = useState<string | null>(null);

  const reset = () => {
    draft.reset();
    setSaveError(null);
  };
  const splitMutation = useActionMutation({
    mutationFn: purchase.split.mutationOptions,
    success: (items) => `Split into ${countLabel(items.length, "expense")}`,
    onSuccess: () => {
      onOpenChange(false);
      reset();
      // This expense no longer exists — staying here would render a deleted row.
      // The Purchase is where every part now lives.
      void navigate(entityDetailLink("purchase", purchaseShortcode));
    },
  });

  const result = check.data;
  const blocked = result ? result.split === null : true;
  const productLabel = start.data?.productName ?? "the linked product";

  return (
    <WorkflowDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      size="lg"
      title={start.data?.title ?? `Split "${expense.name}"`}
      description={start.data?.description ?? "Loading…"}
      error={start.isError ? String(start.error) : saveError}
      primary={{
        label: `Split into ${parts.length}`,
        pendingLabel: "Splitting...",
        pending: splitMutation.isPending,
        disabled: blocked || start.data === undefined,
        onClick: async () => {
          // Ask again with exactly what is typed now: the live check may lag a keystroke.
          const latest = await queryClient.fetchQuery({
            ...purchase.checkSplit.queryOptions({
              expenseId: expense.id,
              attributionPolicy,
              parts: parts.map(bare),
            }),
            staleTime: 0,
          });
          if (!latest.split) {
            setSaveError(latest.reason ?? "These parts cannot be saved.");
            return;
          }
          setSaveError(null);
          splitMutation.mutate(latest.split);
        },
      }}
    >
      <Stack gap="sm" className="max-h-80 overflow-y-auto">
        {parts.map((part, index) => (
          <SplitPartCard
            key={part.key}
            part={part}
            index={index}
            canRemove={parts.length > 2}
            offersProduct={start.data?.productNote != null}
            productLabel={productLabel}
            vendor={expense.vendor}
            onChange={(patch) => draft.updatePart(part.key, patch)}
            onKeepProduct={(keep) => draft.setProductPart(part.key, keep)}
            onRemove={() => draft.removePart(part.key)}
          />
        ))}
      </Stack>

      <Row align="center" justify="between" gap="sm">
        <Stack gap="tight">
          <Button
            variant="outline"
            size="sm"
            onClick={draft.addPart}
            disabled={parts.length >= draft.maxParts}
          >
            <PlusIcon />
            Add part
          </Button>
          {draft.maxParts > 0 && parts.length >= draft.maxParts ? (
            <Description size="2xs">
              A split can contain at most {draft.maxParts} parts.
            </Description>
          ) : null}
        </Stack>
        {start.data?.productNote ? (
          <Description size="2xs">{start.data.productNote}</Description>
        ) : null}
      </Row>

      {result?.needsAttributionPolicy ? (
        <StaticPicker
          items={ATTRIBUTION_OPTIONS.map((option) => ({ ...option }))}
          value={attributionPolicy ?? null}
          onValueChange={(next) => {
            const parsed = splitAttributionPolicy.safeParse(next);
            draft.setAttributionPolicy(
              parsed.success ? parsed.data : undefined,
            );
          }}
          label="Household attribution"
          placeholder="Choose what happens to the household attribution"
          compact
        />
      ) : null}

      <SplitTotals result={result} originalCost={start.data?.originalCost} />
    </WorkflowDialog>
  );
}
