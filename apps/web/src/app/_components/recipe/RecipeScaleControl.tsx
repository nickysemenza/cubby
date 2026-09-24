import type { RecipeOut } from "@cubby/schemas/recipe";
import { ArrowsOutIcon as Scaling } from "@phosphor-icons/react/dist/csr/ArrowsOut";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import type { CalculateTotalsResult } from "~/lib/recipe-costing";

import { resolveScaleFactor, type ScaleAnchor } from "./recipe-scaling";
import { getIngredientName } from "./recipe-utils";

const QUICK_FACTORS = [0.5, 1, 2, 3] as const;

const factorLabel = (f: number): string =>
  f === 0.5 ? "½×" : `${Number.isInteger(f) ? f : Number(f.toFixed(2))}×`;

type AnchorMode = ScaleAnchor["type"];

const isAnchorMode = (value: string): value is AnchorMode =>
  value === "multiplier" || value === "totalWeight" || value === "ingredient";

/**
 * An ingredient whose line couldn't reach grams, so the total-weight anchor
 * can't use it. Links to where the missing mapping is fixed: the product edit
 * form when the ingredient resolves to exactly one product, else the ingredient
 * hub (which lists its products).
 */
export interface MissingWeightLink {
  ingredientShortcode: string;
  name: string;
  /** Single-product ingredient links straight to the product instead. */
  productShortcode: string | null;
}

interface RecipeScaleControlProps {
  recipe: RecipeOut;
  /** Costing rollup (for the totalWeight anchor); null while loading. */
  totals: CalculateTotalsResult | null;
  /** Ingredients blocking the total-weight anchor (no gram conversion). */
  missingWeightLinks: MissingWeightLink[];
  /** Current resolved scale factor (1 = unscaled). */
  factor: number;
  onFactorChange: (factor: number) => void;
}

/**
 * Recipe scaling control: quick ×-chips plus a popover to anchor the scale on a
 * target total weight or a specific ingredient's amount. Presentational +
 * controlled — the parent owns `factor` (URL state) and re-derives the recipe.
 */
export function RecipeScaleControl({
  recipe,
  totals,
  missingWeightLinks,
  factor,
  onFactorChange,
}: RecipeScaleControlProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AnchorMode>("multiplier");
  const [draft, setDraft] = useState("");
  const [ingredientRowId, setIngredientRowId] = useState<string>("");

  // Ingredient rows that carry a numeric primary amount — the candidates the
  // "an ingredient" anchor can pin the scale to.
  const ingredientRows = useMemo(
    () =>
      recipe.sections.flatMap((s) =>
        s.ingredients.flatMap((row) => {
          const amt = row.amounts[0];
          if (!amt || amt.value <= 0) return [];
          return [
            {
              id: row.id,
              name: getIngredientName(row),
              unit: amt.unit,
              value: amt.value,
            },
          ];
        }),
      ),
    [recipe.sections],
  );
  const ingredientOptions = useMemo(
    () =>
      ingredientRows.map((row) => ({
        value: row.id,
        label: `${row.name} (${row.value} ${row.unit})`,
      })),
    [ingredientRows],
  );

  const scaled = factor !== 1;
  const selectedRow = ingredientRows.find((r) => r.id === ingredientRowId);

  const applyAnchor = () => {
    const value = Number.parseFloat(draft);
    if (!Number.isFinite(value) || value <= 0) return;

    let anchor: ScaleAnchor;
    switch (mode) {
      case "multiplier":
        anchor = { type: "multiplier", value };
        break;
      case "totalWeight":
        anchor = { type: "totalWeight", grams: value };
        break;
      case "ingredient":
        if (!selectedRow) return;
        anchor = { type: "ingredient", rowId: selectedRow.id, newValue: value };
        break;
    }
    onFactorChange(resolveScaleFactor(anchor, recipe, totals, factor));
    setOpen(false);
  };

  // Highlight the matching quick chip when the current factor is one of them;
  // otherwise nothing in the chip group is selected (it's a custom factor).
  const activeChip = QUICK_FACTORS.find((f) => f === factor);

  return (
    <Row align="center" wrap gap="sm" className="max-sm:w-full">
      <span className="eyebrow">Scale</span>

      {/* Quick ×-chips */}
      <ToggleGroup
        aria-label="Scale recipe"
        variant="outline"
        size="sm"
        value={[activeChip != null ? String(activeChip) : "custom"]}
        onValueChange={(values: string[]) => {
          const next = values[0];
          if (next && next !== "custom") onFactorChange(Number(next));
        }}
      >
        {QUICK_FACTORS.map((f) => (
          <ToggleGroupItem
            key={f}
            value={String(f)}
            aria-label={`Scale ${factorLabel(f)}`}
            className="max-sm:min-h-11"
          >
            {factorLabel(f)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* Custom anchor popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button variant="outline" size="sm" className="max-sm:min-h-11">
              <Scaling className="mr-1 size-3" />
              {scaled ? `${Number(factor.toFixed(2))}×` : "Custom"}
            </Button>
          }
        />
        <PopoverContent className="w-[min(18rem,calc(100vw-2rem))] space-y-4">
          <Stack gap="sm">
            <Label className="eyebrow">Scale by</Label>
            <ToggleGroup
              aria-label="Scale anchor"
              variant="outline"
              size="sm"
              spacing={0}
              className="w-full"
              value={[mode]}
              onValueChange={(values: string[]) => {
                const next = values.find(isAnchorMode);
                if (next) {
                  setMode(next);
                  setDraft("");
                }
              }}
            >
              <ToggleGroupItem value="multiplier" className="flex-1">
                ×
              </ToggleGroupItem>
              <ToggleGroupItem value="totalWeight" className="flex-1">
                Weight
              </ToggleGroupItem>
              <ToggleGroupItem value="ingredient" className="flex-1">
                Ingredient
              </ToggleGroupItem>
            </ToggleGroup>
          </Stack>

          {mode === "ingredient" && (
            <StaticPicker
              items={ingredientOptions}
              value={ingredientRowId}
              onValueChange={(value) => {
                const nextValue = value ?? "";
                setIngredientRowId(nextValue);
                const row = ingredientRows.find((r) => r.id === nextValue);
                if (row) setDraft(String(row.value));
                else setDraft("");
              }}
              label="Ingredient to scale by"
              placeholder="Choose an ingredient…"
              compact
              clearable
            />
          )}

          <Row
            as="form"
            align="end"
            gap="sm"
            onSubmit={(e) => {
              e.preventDefault();
              applyAnchor();
            }}
          >
            <Stack gap="xs" className="flex-1">
              <Label className="text-2xs text-muted-foreground">
                {mode === "multiplier" && "Multiplier"}
                {mode === "totalWeight" && "Target total weight (g)"}
                {mode === "ingredient" &&
                  (selectedRow
                    ? `Target amount (${selectedRow.unit})`
                    : "Target amount")}
              </Label>
              <Input
                type="number"
                step="any"
                min="0"
                inputMode="decimal"
                value={draft}
                placeholder={
                  mode === "totalWeight"
                    ? totals?.weight
                      ? `now ${Math.round(totals.weight)}`
                      : "—"
                    : undefined
                }
                onChange={(e) => setDraft(e.target.value)}
                disabled={mode === "ingredient" && !selectedRow}
              />
            </Stack>
            <Button type="submit" size="sm" className="max-sm:min-h-11">
              Apply
            </Button>
          </Row>

          {/* In weight mode, name the ingredients that can't reach grams so the
              user can fix them. Fires whenever there are offenders — a fully
              weightless recipe (no `totals.weight`) AND a partial one (the
              total silently excludes these lines, making weight-scaling
              inaccurate). Falls back to the passive line only when there's
              nothing to point at (e.g. still loading). */}
          {mode === "totalWeight" &&
            (missingWeightLinks.length > 0 ? (
              <Stack gap="xs" className="text-2xs text-muted-foreground">
                <p>
                  {totals?.weight
                    ? "These ingredients aren't in the weight total. Add a unit mapping for:"
                    : "No weight conversion yet. Add a unit mapping for:"}
                </p>
                <Stack as="ul" gap="xs">
                  {missingWeightLinks.map((link) => (
                    <li key={link.ingredientShortcode}>
                      <Link
                        to={
                          link.productShortcode
                            ? "/products/$shortcode"
                            : "/ingredients/$shortcode"
                        }
                        params={{
                          shortcode:
                            link.productShortcode ?? link.ingredientShortcode,
                        }}
                        className="text-primary underline-offset-2 hover:underline"
                        onClick={() => setOpen(false)}
                      >
                        {link.name}
                      </Link>
                    </li>
                  ))}
                </Stack>
              </Stack>
            ) : !totals?.weight ? (
              <Description size="2xs">
                No weight conversion yet — add a unit mapping to scale by
                weight.
              </Description>
            ) : null)}
        </PopoverContent>
      </Popover>

      {scaled && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reset scale to 1×"
          onClick={() => onFactorChange(1)}
        >
          <X className="size-3" />
        </Button>
      )}
    </Row>
  );
}
