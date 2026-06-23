import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { BASE_KINDS } from "~/lib/conversion-coverage";
import { queryKeys } from "~/lib/query-keys";
import { type RouterOutputs, useTRPC } from "~/trpc/react";
import type { UnitCoverageItem } from "./unit-coverage-items";

type ProductDetail = NonNullable<RouterOutputs["product"]["getByID"]>;

// Re-export the pure core (defined in unit-coverage-items.ts so it stays
// unit-testable) so the registry can import everything from one place.
export {
  buildUnitCoverageItems,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-items";

/** The recurring number input in these fixes, with its shared defaults. */
function NumberInput({ step = "any", ...props }: ComponentProps<typeof Input>) {
  return (
    <Input type="number" inputMode="decimal" min="0" step={step} {...props} />
  );
}

const KIND_LABEL: Record<(typeof BASE_KINDS)[number], string> = {
  weight: "weight",
  volume: "volume",
  money: "price",
  calories: "calories",
};

/**
 * The four base measurement kinds, lit when the graph can already reach them.
 * When `usdaLinked` is provided, also shows a "USDA" chip — so it's clear
 * whether a gap (e.g. calories) is because nothing's linked, or because the
 * linked food simply has no data for that kind.
 *
 * `applicable` (the kinds graded against — see `gradedKinds`) splits the unlit
 * chips into two: a kind that's applicable but unreached is a real gap (faded);
 * a kind the user marked N/A is struck through ("—" / not applicable), so a
 * count-only ingredient doesn't read as missing a volume it never uses. Omitting
 * `applicable` grades all four (legacy callers / placeholders).
 */
export function CoverageChips({
  covered,
  applicable,
  usdaLinked,
}: {
  covered: string[];
  applicable?: string[];
  usdaLinked?: boolean;
}) {
  const lit = new Set(covered);
  const na = applicable
    ? new Set(BASE_KINDS.filter((k) => !applicable.includes(k)))
    : new Set<string>();
  const chip = (key: string, label: string, on: boolean) => (
    <Badge
      key={key}
      variant={on ? "secondary" : "outline"}
      className={on ? undefined : "text-muted-foreground/50"}
    >
      {on && <Check className="mr-1 h-3 w-3" />}
      {label}
    </Badge>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {BASE_KINDS.map((kind) =>
        na.has(kind) ? (
          <Badge
            key={kind}
            variant="outline"
            className="text-muted-foreground/40 line-through"
            title="not applicable"
          >
            {KIND_LABEL[kind]}
          </Badge>
        ) : (
          chip(kind, KIND_LABEL[kind], lit.has(kind))
        ),
      )}
      {usdaLinked !== undefined && chip("usda", "USDA", usdaLinked)}
    </div>
  );
}

/** Parse a text input as a positive number, or null if blank/invalid. */
const parsePositive = (raw: string): number | null => {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Merge new mappings onto a product's existing rows for a `product.update`,
 * which replace-all's the whole set — so omitting the existing rows (carried
 * with their ids) would silently delete every current mapping. Returns null
 * when the product hasn't loaded yet, so callers refuse rather than wipe.
 */
function withExistingMappings(
  product: ProductDetail | null | undefined,
  newMappings: UnitMappingInput[],
): UnitMappingInput[] | null {
  if (!product) return null;
  return [
    ...product.unitMappings.map((m) => ({
      id: m.id,
      a: m.a,
      b: m.b,
      source: m.source,
    })),
    ...newMappings,
  ];
}

/** The inline fix body — variant chosen by the item's kind / ingredient flag. */
export function UnitCoverageInlineFix({
  item,
  close,
}: {
  item: UnitCoverageItem;
  close: () => void;
}) {
  // Ingredient cases (`partial`, `none` + ingredient) are handled by a "Fix in
  // workbench" link in the section — the workbench is the one editor for
  // ingredient enrichment — so they never reach here. Only the non-ingredient
  // inline fixes remain: bridge islands, or set a price on a non-food product.
  return match(item)
    .with({ kind: "islanded" }, (i) => (
      <DisconnectedFix id={i.id} islands={i.islands} close={close} />
    ))
    .with({ kind: "none", isIngredient: false }, (i) => (
      <PriceFix id={i.id} close={close} />
    ))
    .otherwise(() => null);
}

/** Non-food product: a price is the whole fix. */
function PriceFix({ id, close }: { id: string; close: () => void }) {
  const api = useTRPC();
  const [price, setPrice] = useState("");
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Price saved",
    invalidateKeys: [queryKeys.product.list],
    onSuccess: close,
  });

  const save = () => {
    const value = parsePositive(price);
    if (value == null) {
      toast.error("Enter a price greater than 0");
      return;
    }
    update.mutate({ id, data: { price: value } });
  };

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Not a food — just needs a price.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span>1 each = $</span>
        <NumberInput
          step="0.01"
          placeholder="0.00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="w-24"
        />
        <Button size="sm" onClick={save} disabled={update.isPending}>
          Save price
        </Button>
      </div>
    </div>
  );
}

/**
 * Disconnected mappings: pre-fill N−1 bridge rows chaining each island's
 * representative unit, and append the filled ones to the product's existing
 * mappings.
 */
function DisconnectedFix({
  id,
  islands,
  close,
}: {
  id: string;
  islands: { units: string[]; exampleUnit: string }[];
  close: () => void;
}) {
  const api = useTRPC();
  // One bridge per adjacent island pair connects all N into a single graph.
  const bridges = islands.slice(0, -1).map((isl, i) => ({
    from: isl.exampleUnit,
    to: islands[i + 1]?.exampleUnit ?? "unknown",
  }));
  const [values, setValues] = useState<string[]>(() => bridges.map(() => ""));

  // Load the current mappings so we can resend them — product.update replaces the
  // whole set, so omitting them would silently delete every existing mapping.
  const {
    data: product,
    isLoading,
    isError,
  } = useQuery(api.product.getByID.queryOptions({ id }));
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Conversion saved",
    invalidateKeys: [
      queryKeys.product.list,
      api.product.getByID.queryKey({ id }),
    ],
    onSuccess: close,
  });

  const save = () => {
    const newMappings = bridges.flatMap((b, i) => {
      const value = parsePositive(values[i] ?? "");
      if (value == null) return [];
      return [
        {
          a: { value: 1, unit: b.from },
          b: { value, unit: b.to },
          source: "manual: bridge (problems page)",
        },
      ];
    });
    if (newMappings.length === 0) {
      toast.error("Fill in at least one conversion");
      return;
    }
    const merged = withExistingMappings(product, newMappings);
    if (!merged) {
      toast.error("Couldn't load current conversions — try again");
      return;
    }
    update.mutate({ id, data: { unitMappings: merged } });
  };

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Add the missing conversion(s) to connect the groups.
      </p>
      {bridges.map((b, i) => (
        <div
          key={`${b.from}-${b.to}`}
          className="flex items-center gap-2 text-sm"
        >
          <span>1 {b.from} =</span>
          <NumberInput
            placeholder="?"
            value={values[i] ?? ""}
            onChange={(e) =>
              setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))
            }
            className="w-20"
          />
          <span>{b.to}</span>
        </div>
      ))}
      {isError && (
        <p className="text-destructive text-xs">
          Couldn't load this product's current conversions.
        </p>
      )}
      <Button
        size="sm"
        onClick={save}
        disabled={update.isPending || isLoading || !product}
      >
        {isLoading ? "Loading…" : "Save conversion"}
      </Button>
    </div>
  );
}
