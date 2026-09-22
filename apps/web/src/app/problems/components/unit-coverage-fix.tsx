import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";

import type { UnitCoverageItem } from "./unit-coverage-items";

type ProductDetail = NonNullable<EntityDetailByEntity["product"]>;
const updateProduct = entityMutationOptionsFactory("product", "update");

// CoverageChips moved to the units folder (lean deps — Badge/Row/BASE_KINDS only)
// so list/detail bundles that show coverage don't pull in this file's mutation
// hooks + transport. Re-exported here for existing problems-page callers.
export { CoverageChips } from "~/app/_components/units/CoverageChips";
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
    .with({ kind: "titleSize" }, (i) => (
      <TitleSizeFix
        id={i.id}
        proposed={i.proposed}
        token={i.token}
        close={close}
      />
    ))
    .otherwise(() => null);
}

/**
 * Accept a size the product's own title already states.
 *
 * The amount is pre-parsed server-side by the Rust grammar, so this form only
 * confirms it — but it stays EDITABLE, because the one thing a human can see
 * that the parser cannot is whether the number belongs to this product at all.
 * Titles carrying a pack count are refused upstream (they parse 6-12x too
 * small); this is the last line for the rest.
 */
function TitleSizeFix({
  id,
  proposed,
  token,
  close,
}: {
  id: string;
  proposed: { value: number; unit: string };
  token: string;
  close: () => void;
}) {
  const [value, setValue] = useState(String(proposed.value));
  const { data: product } = useQuery(
    entityDetailFor("product").queryOptions(id),
  );
  const update = useActionMutation({
    mutationFn: updateProduct,
    success: "Size saved",
    onSuccess: close,
  });

  const save = () => {
    const parsed = parsePositive(value);
    if (parsed == null) {
      toast.error("Enter a size greater than 0");
      return;
    }
    // `product.update` REPLACES the whole mapping set, so the existing edges
    // have to be resent — same trap `DisconnectedFix` documents above.
    const merged = withExistingMappings(product, [
      {
        a: { value: 1, unit: "each" },
        b: { value: parsed, unit: proposed.unit },
        source: `title: "${token}"`,
      },
    ]);
    if (!merged) {
      toast.error("Couldn't load current conversions — try again");
      return;
    }
    update.mutate({ id, data: { unitMappings: merged } });
  };

  return (
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Read “{token}” from the product name. Check it describes one unit of
        this product, not a multi-pack.
      </p>
      <Row align="center" gap="sm" className="text-sm">
        <span>1 each =</span>
        <NumberInput
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-24"
        />
        <span className="font-mono">{proposed.unit}</span>
        <Button size="sm" onClick={save} disabled={update.isPending}>
          Save size
        </Button>
      </Row>
    </Stack>
  );
}

/** Non-food product: a price is the whole fix. */
function PriceFix({ id, close }: { id: string; close: () => void }) {
  const [price, setPrice] = useState("");
  const update = useActionMutation({
    mutationFn: updateProduct,
    success: "Price saved",
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
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Not a food — just needs a price.
      </p>
      <Row align="center" gap="sm" className="text-sm">
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
      </Row>
    </Stack>
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
    error,
    refetch,
  } = useQuery(entityDetailFor("product").queryOptions(id));
  const update = useActionMutation({
    mutationFn: updateProduct,
    success: "Conversion saved",
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
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Add the missing conversion(s) to connect the groups.
      </p>
      {bridges.map((b, i) => (
        <Row
          key={`${b.from}-${b.to}`}
          align="center"
          gap="sm"
          className="text-sm"
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
        </Row>
      ))}
      {isError && (
        <ErrorDisplay
          error={error}
          title="this product's current conversions"
          onRetry={() => void refetch()}
        />
      )}
      <Button
        size="sm"
        onClick={save}
        disabled={update.isPending || isLoading || !product}
      >
        {isLoading ? "Loading…" : "Save conversion"}
      </Button>
    </Stack>
  );
}
