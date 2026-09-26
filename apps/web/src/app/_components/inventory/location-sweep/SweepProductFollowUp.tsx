/**
 * The curation prompt for a product a scan just created.
 *
 * Non-blocking by construction: the item is already stocked before this opens,
 * so dismissing it loses nothing and the sweep never stalls. It exists because
 * a brand-new UPC product lands in a poor state — often a placeholder name, no
 * price, and no ingredient link, the last of which makes it invisible to recipe
 * costing entirely.
 */

import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { IngredientShortcode } from "@cubby/schemas/identifiers";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { useEffect, useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { getOptionalIngredientId } from "~/app/_components/form-fields";
import { useEntityActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

/** A product the sweep just created that could use a moment of curation. */
export interface SweepFollowUp {
  id: ProductShortcode;
  name: string;
  /** Placeholder name or unspecified manufacturer. */
  needsName: boolean;
  /** No price means no cost basis for recipe costing. */
  needsPrice: boolean;
}

const followUpPatch = (
  followUp: SweepFollowUp | null,
  name: string | null,
  price: string,
  ingredient: ComboboxItem | null,
) => {
  const seededName = name ?? followUp?.name ?? "";
  const priceValue = Number.parseFloat(price);
  const namePatch =
    followUp?.needsName &&
    seededName.trim() &&
    seededName.trim() !== followUp.name
      ? seededName.trim()
      : undefined;
  const pricePatch =
    followUp?.needsPrice && Number.isFinite(priceValue) && priceValue > 0
      ? priceValue
      : undefined;
  const ingredientPatch = getOptionalIngredientId(ingredient);
  return {
    seededName,
    namePatch,
    pricePatch,
    ingredientPatch,
    hasChanges:
      namePatch !== undefined ||
      pricePatch !== undefined ||
      ingredientPatch !== undefined,
  };
};

export function SweepProductFollowUp({
  followUp,
  locationName,
  onClose,
  onSaved,
}: {
  followUp: SweepFollowUp | null;
  locationName: string;
  /** Called with the product id once it is dealt with, saved or skipped. */
  onClose: (productId: string) => void;
  onSaved: () => void;
}) {
  // `null` means untouched, so the field can show the scanned name as a
  // starting point and still be cleared. Seeding state with the name directly
  // would make an emptied field snap back to it on the next render.
  const [name, setName] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [ingredient, setIngredient] =
    useState<ComboboxItem<IngredientShortcode> | null>(null);

  const save = useEntityActionMutation({
    entity: "product",
    operation: "update",
    intent: "full",
    mutationFn: entityMutationOptionsFactory("product", "update"),
    success: "Product details saved",
    onSuccess: () => {
      onSaved();
      close();
    },
  });

  const close = () => {
    setName(null);
    setPrice("");
    setIngredient(null);
    if (followUp) onClose(followUp.id);
  };

  // A fast sweep can raise a second follow-up before the first is dismissed;
  // without this the new product would inherit the previous one's draft.
  useEffect(() => {
    setName(null);
    setPrice("");
    setIngredient(null);
  }, [followUp?.id]);

  const { seededName, namePatch, pricePatch, ingredientPatch, hasChanges } =
    followUpPatch(followUp, name, price, ingredient);

  return (
    <Sheet
      open={followUp !== null}
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <SheetContent side="bottom" className="p-4" showCloseButton={false}>
        <SheetHeader className="p-0 pb-4">
          <SheetTitle>
            {followUp?.needsName
              ? "Scanned item needs a name"
              : "New product added"}
          </SheetTitle>
          <SheetDescription>
            {followUp?.name} was added to {locationName}. Fill in what you know
            — a name and price make it usable, an ingredient link lets it count
            toward recipe costing. Skip to keep scanning.
          </SheetDescription>
        </SheetHeader>
        <Stack gap="sm">
          {followUp?.needsName && (
            <Input
              value={seededName}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.select()}
              placeholder="Product name"
              aria-label="Product name"
              disabled={save.isPending}
            />
          )}
          {followUp?.needsPrice && (
            <Input
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="Price per each ($)"
              aria-label="Price per each in dollars"
              disabled={save.isPending}
            />
          )}
          <EntityReferencePicker
            entity="ingredient"
            creatable
            label="ingredient"
            value={ingredient}
            setValue={setIngredient}
          />
          <Row gap="sm" justify="end">
            <Button
              type="button"
              variant="ghost"
              className="min-h-12 shrink-0 md:min-h-10"
              disabled={save.isPending}
              onClick={close}
            >
              Skip
            </Button>
            <Button
              type="button"
              className="min-h-12 shrink-0 md:min-h-10"
              disabled={!hasChanges || save.isPending}
              onClick={() => {
                if (!followUp || !hasChanges) return;
                save.mutate({
                  id: followUp.id,
                  data: {
                    ...(namePatch !== undefined && { name: namePatch }),
                    ...(pricePatch !== undefined && { price: pricePatch }),
                    ...(ingredientPatch !== undefined && {
                      ingredientId: ingredientPatch,
                    }),
                  },
                });
              }}
            >
              {save.isPending ? <Spinner /> : <CheckIcon className="size-4" />}
              Save
            </Button>
          </Row>
        </Stack>
      </SheetContent>
    </Sheet>
  );
}
