import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { Check, Plus, X } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import { UnitMappingGraph } from "~/app/_components/units/unit-mapping-graph";
import { UnitMappingsTable } from "~/app/_components/units/unitmappingstable";
import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { BASE_KINDS, type BaseKind } from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithRecompute } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
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

// ---------------------------------------------------------------------------
// Shared sub-fields
// ---------------------------------------------------------------------------

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
      <p className="font-medium text-xs">Set a price</p>
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
      <p className="font-medium text-xs">
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
              <X className="h-3.5 w-3.5" />
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
        className="text-muted-foreground text-xs hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> Add another
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
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
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
              "flex items-center gap-1 text-[11px]",
              off ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Checkbox checked={off} className="pointer-events-none h-3 w-3" />
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
}: {
  row: EnrichmentRow;
  previewMappings: UnitMapping[];
  currentMappings: UnitMapping[];
  linkedFoods: { foodInfo: { description: string } }[];
  naKinds: BaseKind[];
  onToggleNa: (kind: BaseKind) => void;
  naDisabled: boolean;
}) {
  return (
    <Stack className="shrink-0 lg:w-72">
      {(linkedFoods.length > 0 || currentMappings.length > 0) && (
        <Stack
          gap="xs"
          className="rounded-md border border-[var(--border-chunky)] bg-background/60 p-2 text-xs"
        >
          {linkedFoods.length > 0 && (
            <Row as="p" align="center" gap="xs">
              <Check className="h-3 w-3 text-positive" />
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
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Unit graph (live)
        </p>
        <UnitMappingGraph mappings={previewMappings} />
      </Stack>
      <Stack gap="xs">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Coverage (live)
        </p>
        <div className="rounded-md border border-[var(--border-chunky)] bg-background/60 p-2">
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

// ---------------------------------------------------------------------------
// EnrichmentEditor — the single editing body shared by Browse + Review
// ---------------------------------------------------------------------------

export interface EnrichmentEditorHandle {
  save: () => void;
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
  onSaved,
  onUnitChange,
  slots,
  ref,
}: {
  row: EnrichmentRow;
  initialFood?: FoodSummaryWithLinkedProducts | null;
  /** Seed the price unit (Queue carries the last-used unit across cards). */
  initialPriceUnit?: string;
  onSaved?: () => void;
  onUnitChange?: (unit: string) => void;
  slots: EnrichmentEditorSlots;
  ref?: Ref<EnrichmentEditorHandle>;
}) {
  const api = useTRPC();
  const gaps = useMemo(() => analyzeGaps(row), [row]);
  const product = row.product[0] ?? null;

  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(
    initialFood,
  );
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnitState] = useState(
    initialPriceUnit ?? defaultPriceUnit(row),
  );
  const [price, setPrice] = useState("");
  const [convRows, setConvRows] = useState<ConvRow[]>([
    blankConvRow(gaps.islandedUnit ?? ""),
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

  const createProduct = useActionMutation({
    mutationFn: api.product.create.mutationOptions,
    success: (d) => savedWithRecompute(d.sideEffects, `Enriched ${d.name}`),
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => onSaved?.(),
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });
  const updateProduct = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: (d) => savedWithRecompute(d.sideEffects, `Updated ${d.name}`),
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: () => onSaved?.(),
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });
  const updateIngredient = useActionMutation({
    mutationFn: api.ingredient.update.mutationOptions,
    success: `Updated ${row.name}.`,
    invalidateKeys: [["ingredient"]],
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });

  const naKinds = row.naKinds ?? [];
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
    const write = buildProductWrite(row, { food, eachPrice, newMappings });
    if (write.kind === "create") createProduct.mutate(write.input);
    else updateProduct.mutate({ id: write.id, data: write.data });
  }, [
    row,
    food,
    price,
    priceQty,
    priceUnit,
    convRows,
    createProduct,
    updateProduct,
  ]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  const isPending = createProduct.isPending || updateProduct.isPending;

  const convHint = gaps.priceIslanded
    ? {
        title: "Connect the price",
        detail: `— links “${gaps.islandedUnit}” to grams so your price is reachable`,
      }
    : gaps.conversionNeeded
      ? {
          title: "Add conversions",
          detail: `— covers ${gaps.conversionGaps.join(", ")} (e.g. 1 cup = 240 g)`,
        }
      : { title: "Add conversions", detail: "— optional, e.g. 1 cup = 240 g" };

  return (
    <Stack>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Stack className="min-w-0 flex-1">
          {slots.header}

          {product != null &&
            !gaps.isComplete &&
            gaps.missingKinds.length > 0 && (
              <p className="text-xs">
                <span className="font-medium text-warning">Still missing:</span>{" "}
                {gaps.missingKinds.join(", ")}
              </p>
            )}

          {!gaps.usdaLinked && (
            <Stack gap="xs">
              <p className="font-medium text-xs">
                Link a USDA food{" "}
                <span className="font-normal text-muted-foreground">
                  — fills weight, volume &amp; calories
                </span>
              </p>
              {slots.usdaPicker({ food, setFood })}
            </Stack>
          )}

          {gaps.priceIslanded && (
            <p className="rounded-md border bg-warning/10 px-2 py-2 text-warning text-xs">
              Already priced, but “{gaps.islandedUnit}” isn’t linked to a weight
              — so the price can’t be reached from a recipe measure. Connect it
              below (e.g. 1 {gaps.islandedUnit} = N&nbsp;g) instead of adding a
              new price.
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
        </Stack>

        <LivePanels
          row={row}
          previewMappings={previewMappings}
          currentMappings={gaps.currentMappings}
          linkedFoods={gaps.linkedFoods}
          naKinds={naKinds}
          onToggleNa={toggleNaKind}
          naDisabled={updateIngredient.isPending}
        />
      </div>

      {slots.footer}
    </Stack>
  );
}
