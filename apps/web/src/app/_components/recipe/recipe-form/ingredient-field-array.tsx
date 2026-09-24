import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsThreeVertical";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type { FC, KeyboardEvent } from "react";
import { useState } from "react";
import { Controller, type UseFormReturn, useFieldArray } from "react-hook-form";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { QuantityInput } from "~/components/ui/quantity-input";
import { cn } from "~/lib/utils";

import { WithEntitySearch } from "../../combobox/with-search-hook";
import { ComboboxField } from "../../form-utils";
import { IngredientReparse } from "./ingredient-reparse";
import type { IngItem, RecipeFormValues } from "./types";

interface IngredientFieldArrayProps {
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
}

const newRow = (type: IngItem["type"]): IngItem =>
  type === "ingredient"
    ? {
        type: "ingredient",
        ingredient: { id: "", name: "" },
        recipe: null,
        amounts: [{ value: null, unit: "" }],
      }
    : {
        type: "recipe",
        ingredient: null,
        recipe: { id: "", name: "" },
        amounts: [{ value: null, unit: "" }],
      };

/** Bare qty/unit inputs for one amount — no labels, ledger-row density. The
 * optional "to" (upper-bound) input renders only when `showUpper` is set, so the
 * common single-amount case stays a clean qty/unit pair; the caller reveals it
 * via the row menu (or when a range was already entered). */
const AmountInputs: FC<{
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
  ingredientIndex: number;
  amountIndex: number;
  showUpper: boolean;
  onEnter?: () => void;
}> = ({
  form,
  sectionIndex,
  ingredientIndex,
  amountIndex,
  showUpper,
  onEnter,
}) => {
  const base =
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts.${amountIndex}` as const;

  const handleEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };

  return (
    <>
      <Controller
        control={form.control}
        name={`${base}.value`}
        render={({ field }) => (
          <QuantityInput
            value={field.value ?? null}
            onChange={field.onChange}
            onEnter={onEnter}
            aria-label="Amount"
            placeholder="qty"
            // Span the (empty) upper column when there's no range so unit/name
            // stay aligned across ranged and non-ranged rows — the qty just
            // widens instead of leaving a gap.
            className={cn(!showUpper && "col-span-2")}
          />
        )}
      />
      {showUpper && (
        <Controller
          control={form.control}
          name={`${base}.upperValue`}
          render={({ field }) => (
            <QuantityInput
              value={field.value ?? null}
              onChange={field.onChange}
              onEnter={onEnter}
              aria-label="Upper amount"
              placeholder="to"
              className="text-muted-foreground"
            />
          )}
        />
      )}
      <Controller
        control={form.control}
        name={`${base}.unit`}
        render={({ field }) => (
          <Input
            aria-label="Unit"
            placeholder="unit"
            className="font-mono"
            value={field.value ?? ""}
            onChange={(e) => field.onChange(e.target.value)}
            onKeyDown={handleEnter}
          />
        )}
      />
    </>
  );
};

/**
 * Ledger-style ingredient editor: one line per ingredient
 * ([qty][unit][name][⋮]), dashed rules between rows. Type switching, extra
 * amounts, the entity link, and row moves live in the ⋮ menu; Enter in the
 * qty/unit of the last row appends the next one.
 */
export const IngredientFieldArray: FC<IngredientFieldArrayProps> = ({
  form,
  sectionIndex,
}) => {
  const { fields, append, remove, move, update } = useFieldArray({
    control: form.control,
    name: `sections.${sectionIndex}.ingredients`,
  });

  // Rows whose "to" (upper-bound) input the user revealed this session, keyed by
  // the stable field id. A row also shows it whenever a range value is present.
  const [revealedUpper, setRevealedUpper] = useState<Set<string>>(new Set());
  const revealUpper = (id: string) =>
    setRevealedUpper((prev) => new Set(prev).add(id));

  const appendRow = () => append(newRow("ingredient"));

  return (
    <div className="w-full">
      {fields.length === 0 ? (
        <div className="py-1 text-sm text-muted-foreground italic">
          No ingredients yet — add the first row below.
        </div>
      ) : (
        <div className="divide-y divide-dashed divide-border">
          {fields.map((field, ingredientIndex) => {
            const path =
              `sections.${sectionIndex}.ingredients.${ingredientIndex}` as const;
            const row = form.watch(path);
            const isLast = ingredientIndex === fields.length - 1;
            const linked =
              row.type === "ingredient" ? row.ingredient : row.recipe;
            // Show the "to" input when a range is already entered, or the user
            // revealed it via the row menu. Otherwise the row stays qty/unit and
            // the grid drops the upper column.
            const showUpper =
              row.amounts[0]?.upperValue != null || revealedUpper.has(field.id);

            return (
              <div key={field.id} className="py-2">
                <div className="grid grid-cols-[4.5rem_3.5rem_4rem_minmax(0,1.6fr)_minmax(0,1fr)_auto] items-center gap-2">
                  <AmountInputs
                    form={form}
                    sectionIndex={sectionIndex}
                    ingredientIndex={ingredientIndex}
                    amountIndex={0}
                    showUpper={showUpper}
                    onEnter={isLast ? appendRow : undefined}
                  />

                  <div className="min-w-0">
                    {row.type === "ingredient" ? (
                      <WithEntitySearch entity="ingredient">
                        {({
                          items,
                          onSearchChange,
                          isLoading,
                          onCreateNew,
                          onOpenChange,
                        }) => (
                          <ComboboxField
                            entity="ingredient"
                            form={form}
                            name={`${path}.ingredient`}
                            items={items}
                            onSearchChange={onSearchChange}
                            isLoading={isLoading}
                            onCreateNew={onCreateNew}
                            onOpenChange={onOpenChange}
                            // Keep the row's aliases in sync with the picked
                            // ingredient so the Re-parse drift check doesn't
                            // false-positive on an alias match.
                            onSelect={(item) =>
                              form.setValue(
                                `${path}.aliases`,
                                item?.aliases ?? [],
                              )
                            }
                          />
                        )}
                      </WithEntitySearch>
                    ) : (
                      <WithEntitySearch entity="recipe">
                        {({
                          items,
                          onSearchChange,
                          isLoading,
                          onOpenChange,
                        }) => (
                          <ComboboxField
                            entity="recipe"
                            form={form}
                            name={`${path}.recipe`}
                            items={items}
                            onSearchChange={onSearchChange}
                            isLoading={isLoading}
                            onOpenChange={onOpenChange}
                          />
                        )}
                      </WithEntitySearch>
                    )}
                  </div>

                  {/* Modifier / prep note (e.g. "for frying", "finely chopped").
                      Purpose phrases here drive the usage classifier: "for
                      frying", "to taste", "for the pan", "for garnish", "for
                      dusting" make the totals estimate the row's consumed
                      amount instead of reading it off the line. */}
                  <Controller
                    control={form.control}
                    name={`${path}.modifier`}
                    render={({ field }) => (
                      <Input
                        aria-label="Modifier"
                        placeholder="note, e.g. for frying"
                        // Ghost styling: a secondary annotation, not a competing
                        // boxed input — transparent until hovered/focused so it
                        // doesn't read as colliding with the ingredient combobox.
                        className="min-w-0 border-transparent bg-transparent text-muted-foreground italic hover:border-border hover:bg-input/20"
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value || null)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && isLast) {
                            e.preventDefault();
                            appendRow();
                          }
                        }}
                      />
                    )}
                  />

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Ingredient ${ingredientIndex + 1} options`}
                        />
                      }
                    >
                      <DotsThreeVerticalIcon className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={ingredientIndex === 0}
                        onClick={() =>
                          move(ingredientIndex, ingredientIndex - 1)
                        }
                      >
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={ingredientIndex === fields.length - 1}
                        onClick={() =>
                          move(ingredientIndex, ingredientIndex + 1)
                        }
                      >
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => {
                          const current = form.getValues(path);
                          update(
                            ingredientIndex,
                            current.type === "ingredient"
                              ? {
                                  ...newRow("recipe"),
                                  amounts: current.amounts,
                                }
                              : {
                                  ...newRow("ingredient"),
                                  amounts: current.amounts,
                                },
                          );
                        }}
                      >
                        {row.type === "ingredient"
                          ? "Switch to sub-recipe"
                          : "Switch to ingredient"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          const current = form.getValues(path);
                          form.setValue(`${path}.amounts`, [
                            ...current.amounts,
                            { value: 1, unit: "" },
                          ]);
                        }}
                      >
                        Add second amount
                      </DropdownMenuItem>
                      {!showUpper && (
                        <DropdownMenuItem onClick={() => revealUpper(field.id)}>
                          Add upper amount (range)
                        </DropdownMenuItem>
                      )}
                      {linked?.id && (
                        <DropdownMenuItem
                          onClick={() =>
                            window.open(
                              `/${row.type === "ingredient" ? "ingredients" : "recipes"}/${linked.id}`,
                              "_blank",
                            )
                          }
                        >
                          <ArrowSquareOutIcon />
                          Open{" "}
                          {row.type === "ingredient" ? "ingredient" : "recipe"}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => remove(ingredientIndex)}
                      >
                        <TrashIcon />
                        Delete row
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Extra amounts (e.g. "250 g / 1 cup") on follow-up lines. Alt
                    amounts are distinct unit representations, not ranges, so the
                    "to" input only appears if one was somehow already set. */}
                {row.amounts.slice(1).map((extra, extraIdx) => {
                  const extraShowUpper = extra.upperValue != null;
                  return (
                    <div
                      key={`${field.id}-amount-${extra.value}-${extra.upperValue ?? "point"}-${extra.unit}`}
                      className="mt-1 grid grid-cols-[4.5rem_3.5rem_4rem_minmax(0,1fr)_auto] items-center gap-2"
                    >
                      <AmountInputs
                        form={form}
                        sectionIndex={sectionIndex}
                        ingredientIndex={ingredientIndex}
                        amountIndex={extraIdx + 1}
                        showUpper={extraShowUpper}
                      />
                      <span className="font-mono text-2xs text-muted-foreground">
                        alt. amount
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove this amount"
                        onClick={() => {
                          const current = form.getValues(`${path}.amounts`);
                          form.setValue(
                            `${path}.amounts`,
                            current.filter((_, i) => i !== extraIdx + 1),
                          );
                        }}
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </div>
                  );
                })}

                <IngredientReparse
                  form={form}
                  sectionIndex={sectionIndex}
                  ingredientIndex={ingredientIndex}
                  onApply={(updated) => update(ingredientIndex, updated)}
                />
              </div>
            );
          })}
        </div>
      )}

      <Row gap="sm" className="mt-2">
        <Button type="button" variant="outline" size="sm" onClick={appendRow}>
          <PlusIcon className="mr-2 size-3.5" />
          Ingredient
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => append(newRow("recipe"))}
        >
          <PlusIcon className="mr-2 size-3.5" />
          Sub-recipe
        </Button>
      </Row>
    </div>
  );
};
