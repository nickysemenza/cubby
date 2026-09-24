import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { useEntityActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import { UnitMappingGraph } from "~/app/_components/units/unit-mapping-graph";
import { UnitMappingsTable } from "~/app/_components/units/unitmappingstable";
import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { BASE_KINDS, type BaseKind } from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";

import type { EquivalenceDraft } from "./equivalence-workbench-link";
import {
  analyzeGaps,
  blankConvRow,
  buildPreviewMappings,
  buildPriceAndMappings,
  buildProductWrite,
  type ConvRow,
  defaultPriceUnit,
  UnitInput,
} from "./workbench-editor-core";

const productCreateMutationOptions = entityMutationOptionsFactory(
  "product",
  "create",
);
const productUpdateMutationOptions = entityMutationOptionsFactory(
  "product",
  "update",
);
const ingredientUpdateMutationOptions = entityMutationOptionsFactory(
  "ingredient",
  "update",
);

function PriceField({
  qty,
  unit,
  dollars,
  onQty,
  onUnit,
  onDollars,
}: {
  qty: string;
  unit: string;
  dollars: string;
  onQty: (v: string) => void;
  onUnit: (v: string) => void;
  onDollars: (v: string) => void;
}) {
  return (
    <Stack gap="xs">
      <p className="text-xs font-medium">Set a price</p>
      <Row align="center" gap="sm" className="text-sm">
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          value={qty}
          onChange={(e) => onQty(e.target.value)}
          className="w-12"
          aria-label="Price quantity"
        />
        <UnitInput value={unit} onChange={onUnit} ariaLabel="Price unit" />
        <span>= $</span>
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={dollars}
          onChange={(e) => onDollars(e.target.value)}
          className="w-20"
          aria-label="Price"
        />
      </Row>
      <Description size="xs">
        For foods, price by the package, e.g. 2&nbsp;lb = $5.99. Use “each” for
        count items.
      </Description>
    </Stack>
  );
}

function ConversionRowsField({
  rows,
  hint,
  onPatch,
  onAdd,
  onRemove,
}: {
  rows: ConvRow[];
  hint: { title: string; detail: string };
  onPatch: (id: string, patch: Partial<ConvRow>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <Stack gap="sm">
      <p className="text-xs font-medium">
        {hint.title}{" "}
        <span className="font-normal text-muted-foreground">{hint.detail}</span>
      </p>
      {rows.map((c) => (
        <Row key={c.id} align="center" gap="sm" className="text-sm">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            value={c.fromQty}
            onChange={(e) => onPatch(c.id, { fromQty: e.target.value })}
            className="w-12"
            aria-label="From quantity"
          />
          <UnitInput
            value={c.fromUnit}
            onChange={(v) => onPatch(c.id, { fromUnit: v })}
            placeholder="cup"
            ariaLabel="From unit"
          />
          <span>=</span>
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            value={c.toQty}
            onChange={(e) => onPatch(c.id, { toQty: e.target.value })}
            className="w-14"
            aria-label="To quantity"
          />
          <UnitInput
            value={c.toUnit}
            onChange={(v) => onPatch(c.id, { toUnit: v })}
            placeholder="g"
            ariaLabel="To unit"
          />
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => onRemove(c.id)}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Remove conversion"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </Row>
      ))}
      <Row
        as="button"
        type="button"
        align="center"
        gap="xs"
        onClick={onAdd}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        <PlusIcon className="size-3" /> Add another
      </Row>
    </Stack>
  );
}

function NaKindsField({
  naKinds,
  onToggle,
  disabled,
}: {
  naKinds: BaseKind[];
  onToggle: (kind: BaseKind) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
      <span className="text-2xs tracking-wide text-muted-foreground uppercase">
        N/A
      </span>
      {BASE_KINDS.map((kind) => {
        const off = naKinds.includes(kind);
        return (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(kind)}
            aria-pressed={off}
            className={cn(
              "flex items-center gap-1 text-2xs",
              off ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Checkbox checked={off} className="pointer-events-none size-3" />
            {kind === "money" ? "price" : kind}
          </button>
        );
      })}
    </div>
  );
}

function LivePanels({
  row,
  previewMappings,
  currentMappings,
  linkedFoods,
  naKinds,
  onToggleNa,
  naDisabled,
  className,
}: {
  row: EnrichmentRow;
  previewMappings: UnitMapping[];
  currentMappings: UnitMapping[];
  linkedFoods: { foodInfo: { description: string } }[];
  naKinds: BaseKind[];
  onToggleNa: (kind: BaseKind) => void;
  naDisabled: boolean;
  className?: string;
}) {
  return (
    <Stack className={cn("shrink-0 lg:w-72", className)}>
      {(linkedFoods.length > 0 || currentMappings.length > 0) && (
        <Stack
          gap="xs"
          className="border border-[var(--border)] bg-background/60 p-2 text-xs"
        >
          {linkedFoods.length > 0 && (
            <Row as="p" align="center" gap="xs">
              <CheckIcon className="size-3 text-positive" />
              <span className="text-muted-foreground">Linked USDA:</span>{" "}
              {linkedFoods.map((f) => f.foodInfo.description).join(", ")}
            </Row>
          )}
          {currentMappings.length > 0 && (
            <Stack gap="xs">
              <p className="font-medium">Current conversions</p>
              <UnitMappingsTable mappings={currentMappings} />
            </Stack>
          )}
        </Stack>
      )}
      <Stack gap="xs">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Unit graph (live)
        </p>
        <UnitMappingGraph mappings={previewMappings} />
      </Stack>
      <Stack gap="xs">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Coverage (live)
        </p>
        <div className="border border-[var(--border)] bg-background/60 p-2">
          <ConversionCapabilities
            mappings={previewMappings}
            kinds={row.coverage.applicable}
            hideConvertButton
          />
        </div>
        <NaKindsField
          naKinds={naKinds}
          onToggle={onToggleNa}
          disabled={naDisabled}
        />
      </Stack>
    </Stack>
  );
}

export interface EnrichmentEditorHandle {
  save: () => void;
}

export type EnrichmentEditorLayout = "side" | "compact" | "panel";

const livePanelsClassName = (layout: EnrichmentEditorLayout) => {
  if (layout === "compact") return "w-full lg:w-auto";
  if (layout === "panel") return "w-full";
  return undefined;
};

const conversionHintForGaps = (gaps: ReturnType<typeof analyzeGaps>) => {
  if (gaps.priceIslanded) {
    return {
      title: "Connect the price",
      detail: `— links “${gaps.islandedUnit}” to grams so your price is reachable`,
    };
  }
  if (gaps.conversionNeeded) {
    return {
      title: "Add conversions",
      detail: `— covers ${gaps.conversionGaps.join(", ")} (e.g. 1 cup = 240 g)`,
    };
  }
  return {
    title: "Add conversions",
    detail: "— optional, e.g. 1 cup = 240 g",
  };
};

function EnrichmentEditorBody({
  layout,
  editorFields,
  livePanels,
  footer,
}: {
  layout: EnrichmentEditorLayout;
  editorFields: ReactNode;
  livePanels: ReactNode;
  footer: ReactNode;
}) {
  if (layout === "compact") {
    return (
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
        <Stack className="min-w-0">
          {editorFields}
          {footer}
        </Stack>
        <div className="min-w-0">{livePanels}</div>
      </div>
    );
  }
  if (layout === "panel") {
    return (
      <Stack>
        <Stack className="min-w-0">{editorFields}</Stack>
        <div className="min-w-0">{livePanels}</div>
        {footer}
      </Stack>
    );
  }
  return (
    <Stack>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Stack className="min-w-0 flex-1">{editorFields}</Stack>
        {livePanels}
      </div>
      {footer}
    </Stack>
  );
}

/** Slot API: the surface supplies chrome; the editor owns the editing body. */
interface EnrichmentEditorSlots {
  /** Above the body (Browse: nothing; Queue: AI confidence + position). */
  header?: ReactNode;
  /** The USDA picker, rendered only when the row isn't already linked. */
  usdaPicker: (api: {
    food: FoodSummaryWithLinkedProducts | null;
    setFood: (food: FoodSummaryWithLinkedProducts) => void;
  }) => ReactNode;
  /** Action bar (Browse: Save/Cancel; Queue: Apply). */
  actions: (api: { save: () => void; isPending: boolean }) => ReactNode;
  /** Below the body (Browse: recipe usages; Queue: merge list + legend). */
  footer?: ReactNode;
}

/**
 * The one gap-aware enrichment editor. Owns draft state (food, price,
 * conversions, N/A), the create/update writes, and the live graph + coverage —
 * and shows only the inputs that close the row's actual gaps. Both the Browse
 * table editor and the Review-queue card render this with their own chrome via
 * slots, so the two surfaces cannot drift.
 */
export function EnrichmentEditor({
  row,
  initialFood = null,
  initialPriceUnit,
  initialConversion,
  onSaved,
  onUnitChange,
  slots,
  layout = "side",
  ref,
}: {
  row: EnrichmentRow;
  initialFood?: FoodSummaryWithLinkedProducts | null;
  /** Seed the price unit (Queue carries the last-used unit across cards). */
  initialPriceUnit?: string;
  /** Candidate carried from the equivalences report; the user still saves it. */
  initialConversion?: EquivalenceDraft;
  onSaved?: () => void;
  onUnitChange?: (unit: string) => void;
  slots: EnrichmentEditorSlots;
  layout?: EnrichmentEditorLayout;
  ref?: Ref<EnrichmentEditorHandle>;
}) {
  const gaps = useMemo(() => analyzeGaps(row), [row]);
  const product = row.product[0] ?? null;
  const [mappingProductId, setMappingProductId] = useState<string | null>(
    product?.id ?? null,
  );

  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(
    initialFood,
  );
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnitState] = useState(
    initialPriceUnit ?? defaultPriceUnit(row),
  );
  const [price, setPrice] = useState("");
  const [convRows, setConvRows] = useState<ConvRow[]>([
    initialConversion
      ? blankConvRow(initialConversion.fromUnit, {
          fromValue: initialConversion.fromValue,
          toValue: initialConversion.toValue,
          toUnit: initialConversion.toUnit,
        })
      : blankConvRow(gaps.islandedUnit ?? ""),
  ]);

  const setPriceUnit = (u: string) => {
    setPriceUnitState(u);
    onUnitChange?.(u);
  };
  const patchConvRow = (id: string, patch: Partial<ConvRow>) =>
    setConvRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  const addConvRow = () => setConvRows((rows) => [...rows, blankConvRow()]);
  const removeConvRow = (id: string) =>
    setConvRows((rows) => rows.filter((r) => r.id !== id));

  const previewMappings = useMemo<UnitMapping[]>(
    () =>
      buildPreviewMappings(row, {
        food,
        dollars: price,
        qty: priceQty,
        unit: priceUnit,
        convRows,
      }),
    [row, food, price, priceQty, priceUnit, convRows],
  );

  const createProduct = useEntityActionMutation({
    entity: "product",
    operation: "create",
    mutationFn: productCreateMutationOptions,
    success: (d) =>
      savedWithBackgroundWork(d.sideEffects, `Enriched ${d.name}`),
    onSuccess: () => onSaved?.(),
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });
  const updateProduct = useEntityActionMutation({
    entity: "product",
    operation: "update",
    intent: "full",
    mutationFn: productUpdateMutationOptions,
    success: (d) => savedWithBackgroundWork(d.sideEffects, `Updated ${d.name}`),
    onSuccess: () => onSaved?.(),
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });
  const updateIngredient = useEntityActionMutation({
    entity: "ingredient",
    operation: "update",
    intent: "full",
    mutationFn: ingredientUpdateMutationOptions,
    success: `Updated ${row.name}.`,
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });

  const naKinds = row.naKinds;
  const toggleNaKind = (kind: BaseKind) => {
    const next = new Set(naKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    updateIngredient.mutate({ id: row.id, data: { naKinds: [...next] } });
  };

  const save = useCallback(() => {
    const built = buildPriceAndMappings({
      price,
      priceQty,
      priceUnit,
      convRows,
    });
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    const { eachPrice, newMappings } = built;
    if (food == null && eachPrice == null && newMappings.length === 0) {
      toast.error("Link a USDA food, set a price, or add a conversion first");
      return;
    }
    const write = buildProductWrite(row, {
      food,
      eachPrice,
      newMappings,
      productId: mappingProductId ?? undefined,
    });
    if (write.kind === "create") createProduct.mutate(write.input);
    else updateProduct.mutate({ id: write.id, data: write.data });
  }, [
    row,
    food,
    price,
    priceQty,
    priceUnit,
    convRows,
    mappingProductId,
    createProduct,
    updateProduct,
  ]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  const isPending = createProduct.isPending || updateProduct.isPending;

  const convHint = conversionHintForGaps(gaps);

  const editorFields = (
    <>
      {slots.header}

      {product != null && !gaps.isComplete && gaps.missingKinds.length > 0 && (
        <p className="text-xs">
          <span className="font-medium text-warning-ink">Still missing:</span>{" "}
          {gaps.missingKinds.join(", ")}
        </p>
      )}

      {initialConversion && row.product.length > 1 && (
        <Stack gap="xs">
          <p className="text-xs font-medium">Store this conversion on</p>
          <StaticPicker
            items={row.product.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
            }))}
            value={mappingProductId}
            onValueChange={setMappingProductId}
            label="product"
            placeholder="Choose a product"
          />
          <Description size="xs">
            Unit mappings belong to a concrete product, not the abstract
            ingredient.
          </Description>
        </Stack>
      )}

      {!gaps.usdaLinked && (
        <Stack gap="xs">
          <p className="text-xs font-medium">
            Link a USDA food{" "}
            <span className="font-normal text-muted-foreground">
              — fills weight, volume &amp; calories
            </span>
          </p>
          {slots.usdaPicker({ food, setFood })}
        </Stack>
      )}

      {gaps.priceIslanded && (
        <p className="border bg-warning/10 px-2 py-2 text-xs text-warning-ink">
          Already priced, but “{gaps.islandedUnit}” isn’t linked to a weight —
          so the price can’t be reached from a recipe measure. Connect it below
          (e.g. 1 {gaps.islandedUnit} = N&nbsp;g) instead of adding a new price.
        </p>
      )}

      {gaps.moneyMissing && !gaps.priceIslanded && (
        <PriceField
          qty={priceQty}
          unit={priceUnit}
          dollars={price}
          onQty={setPriceQty}
          onUnit={setPriceUnit}
          onDollars={setPrice}
        />
      )}

      <ConversionRowsField
        rows={convRows}
        hint={convHint}
        onPatch={patchConvRow}
        onAdd={addConvRow}
        onRemove={removeConvRow}
      />

      {slots.actions({ save, isPending })}
    </>
  );

  const livePanels = (
    <LivePanels
      row={row}
      previewMappings={previewMappings}
      currentMappings={gaps.currentMappings}
      linkedFoods={gaps.linkedFoods}
      naKinds={naKinds}
      onToggleNa={toggleNaKind}
      naDisabled={updateIngredient.isPending}
      className={livePanelsClassName(layout)}
    />
  );

  return (
    <EnrichmentEditorBody
      layout={layout}
      editorFields={editorFields}
      livePanels={livePanels}
      footer={slots.footer}
    />
  );
}
