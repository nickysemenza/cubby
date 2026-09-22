import type { AmountKind } from "@cubby/recipebridge";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import {
  manualUnitMapping,
  type UnitMapping,
  type UnitMappingInput,
} from "@cubby/schemas/unitmapping";
import {
  buildNutrients,
  getNutrientUnitString,
  KEY_NUTRIENT_KEYS,
  type NutrientKey,
} from "@cubby/usda-schemas";
import { Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { wasm } from "~/lib/wasm";

import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { NutrientsSummary } from "./NutrientsSummary";

interface ServingAliasFieldProps {
  productId: ProductShortcode;
  /** Stored (non-synthesized) mappings on the product — the array this appends
   * a new manual edge to and sends whole to `product.update`. */
  storedMappings: UnitMappingInput[];
  /** Full synthesized mappings (stored + food + price) — the graph the preview
   * converts through, same as the costing engine sees. */
  previewMappings: UnitMapping[];
}

/**
 * Quick-add affordance for a custom unit alias on a product — "1 serving = 40
 * g", or any word the user wants to type a recipe amount in. Appends a
 * `manualUnitMapping` edge via the same `product.update` mutation the
 * generic editor's `unit-mappings` renderer uses (see
 * `entities/editing/product-editor-fields.tsx`), so the conversion graph
 * immediately chains alias-unit → g → nutrients/price.
 *
 * The nutrient preview is computed live from the entered grams against the
 * product's EXISTING graph (before save) — it's answering "what does X g of
 * this product contain", which is exactly what "1 alias-unit" will resolve to
 * once saved.
 */
export function ServingAliasField({
  productId,
  storedMappings,
  previewMappings,
}: ServingAliasFieldProps) {
  const [unit, setUnit] = useState("serving");
  const [gramsInput, setGramsInput] = useState("");
  const unitFieldId = useId();
  const gramsFieldId = useId();

  const updateProductMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("product", "update"),
    entity: "product",
  });

  const grams = Number(gramsInput);
  const isValid = unit.trim().length > 0 && Number.isFinite(grams) && grams > 0;

  // Live preview: what `grams` grams of this product resolve to for calories +
  // the key nutrients, via the product's already-saved conversion graph. Each
  // target is tried independently — a missing edge (no calorie/nutrient data
  // yet) is normal and just skips that chip, not an error.
  const previewNutrients = useMemo(() => {
    if (!Number.isFinite(grams) || grams <= 0) return null;
    const values: Partial<Record<NutrientKey, number>> = {};
    for (const key of KEY_NUTRIENT_KEYS) {
      const target: AmountKind =
        key === "kcal" ? "calories" : `nutrient:${getNutrientUnitString(key)}`;
      try {
        const result = wasm.conv_amount_to_kind(previewMappings, target, {
          value: grams,
          unit: "g",
        });
        if (Number.isFinite(result.value)) {
          values[key] = result.value;
        }
      } catch {
        // SILENT: no bridge to this nutrient yet — skip, not an error.
      }
    }
    return Object.keys(values).length > 0 ? buildNutrients(values) : null;
  }, [grams, previewMappings]);

  const handleAdd = () => {
    if (!isValid) return;
    const singularized = wasm.singularize_unit(unit.trim());
    const newMapping = manualUnitMapping(
      { value: 1, unit: singularized },
      { value: grams, unit: "g" },
      "serving alias",
    );
    updateProductMutation.mutate(
      {
        id: productId,
        data: { unitMappings: [...storedMappings, newMapping] },
      },
      {
        onSuccess: () => {
          setUnit("serving");
          setGramsInput("");
        },
      },
    );
  };

  return (
    <Row
      align="end"
      gap="sm"
      wrap
      className="border border-dashed border-border p-2"
    >
      <div className="w-28">
        <Label htmlFor={unitFieldId}>Unit</Label>
        <Input
          id={unitFieldId}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="serving"
        />
      </div>
      <span className="pb-2 text-muted-foreground">=</span>
      <div className="w-24">
        <Label htmlFor={gramsFieldId}>Grams</Label>
        <Input
          id={gramsFieldId}
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={gramsInput}
          onChange={(e) => setGramsInput(e.target.value)}
          placeholder="g"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!isValid || updateProductMutation.isPending}
        onClick={handleAdd}
      >
        {updateProductMutation.isPending ? (
          <Spinner size="sm" />
        ) : (
          <Plus aria-hidden />
        )}
        Add alias
      </Button>
      {previewNutrients && (
        <div className="w-full">
          <NutrientsSummary nutrients={previewNutrients} dense />
        </div>
      )}
    </Row>
  );
}
