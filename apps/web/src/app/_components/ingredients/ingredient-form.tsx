import type {
  IngredientUpdateInput,
  IngredientWithRecipesAndProductOut,
  ingredientCreateInput,
} from "@cubby/schemas/ingredient";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { type Control, useWatch } from "react-hook-form";
import type { z } from "zod";

import { AliasesField, filterAliases } from "~/components/forms/aliases-field";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { EntityPrimitiveFields } from "~/entities/editing/entity-primitive-fields";
import { useEntityFormController } from "~/entities/editing/use-entity-form-controller";
import { entityListFor } from "~/entities/entity-list.functions";

import { EntityInlineLink } from "../EntityInlineLink";
import { type EntityFormProps, FormWrapper } from "../form-utils";

// Module-level so `useEntityFormController`'s resolver memoization sees a
// stable reference across renders (never a fresh inline array).
const INGREDIENT_FORM_FIELDS = ["name", "aliases", "usuallyOnHand"] as const;

interface IngredientFormValues {
  name: string;
  aliases: string[];
  usuallyOnHand: boolean;
}

/**
 * Live duplicate-name check for ingredient CREATE. Watches the name field,
 * debounces, and surfaces existing ingredients whose name/aliases match — so an
 * accidental dup is caught before creation (the merge flow exists to clean these
 * up; this stops them landing in the first place). Non-blocking: it links the
 * matches so the user can open one instead, but never prevents creating a
 * genuinely-new ingredient. Reuses `ingredient.list`'s name filter (the same
 * fuzzy search the pickers use) — no new server surface.
 */
function DuplicateNameHint({
  control,
}: {
  control: Control<IngredientFormValues>;
}) {
  const name = useWatch({ control, name: "name" });
  const [debouncedName] = useDebouncedValue(name, { wait: 300 });
  const trimmed = debouncedName?.trim() ?? "";
  const enabled = trimmed.length >= 2;

  const { data } = useQuery({
    ...entityListFor("ingredient").queryOptions({
      filters: { nameFilter: trimmed },
      pagination: { pageIndex: 0, pageSize: 5 },
    }),
    enabled,
  });

  const matches = data?.items ?? [];
  if (!enabled || matches.length === 0) return null;

  // An exact (case-insensitive) hit is a stronger signal than a substring match.
  const lower = trimmed.toLowerCase();
  const exact = matches.some(
    (m) =>
      m.name.toLowerCase() === lower ||
      m.aliases.some((a) => a.toLowerCase() === lower),
  );

  return (
    <Stack gap="xs" className="px-4 pb-2">
      <Description size="xs" className={exact ? "text-warning-ink" : undefined}>
        {exact
          ? "An ingredient with this name already exists — did you mean to use it?"
          : "Similar ingredients already exist. Use one of these instead of creating a duplicate?"}
      </Description>
      <Row gap="xs" wrap>
        {matches.map((m) => (
          <EntityInlineLink
            displayImage={undefined}
            key={m.id}
            entity="ingredient"
            data={{ name: m.name, id: m.id }}
          />
        ))}
      </Row>
    </Stack>
  );
}

type IngredientFormProps = EntityFormProps<
  z.infer<typeof ingredientCreateInput>,
  IngredientUpdateInput,
  IngredientWithRecipesAndProductOut
> & { initialName?: string };

export const IngredientForm: FC<IngredientFormProps> = (props) => {
  const { mode, onCancel } = props;
  const ingredient = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  const controller = useEntityFormController("ingredient", props, {
    fields: INGREDIENT_FORM_FIELDS,
    defaultValues: {
      name: ingredient ? ingredient.name : (initialName ?? ""),
      aliases: ingredient ? ingredient.aliases : [],
      usuallyOnHand: ingredient?.usuallyOnHand ?? false,
    },
    transform: {
      diffValues: (values) => ({
        ...values,
        aliases: filterAliases(values.aliases),
      }),
      create: (values) => ({
        name: values.name,
        aliases: filterAliases(values.aliases),
        usuallyOnHand: values.usuallyOnHand,
        naKinds: [],
      }),
      edit: (updates) => ({ id: ingredient!.id, data: updates }),
    },
  });
  const { form, handleSubmit, isPending, error, submitButtonText } = controller;

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={submitButtonText}
    >
      <Card>
        <CardContent className="px-4 py-1">
          <EntityPrimitiveFields
            entity="ingredient"
            mode={mode}
            section="identity"
            options={{ name: { placeholder: "Enter ingredient name" } }}
          />
        </CardContent>
        {mode === "create" && <DuplicateNameHint control={form.control} />}
      </Card>

      <AliasesField<IngredientFormValues> form={form} />
      <Card>
        <CardContent className="space-y-3 px-4 py-3">
          <EntityPrimitiveFields
            entity="ingredient"
            mode={mode}
            section="main"
          />
        </CardContent>
      </Card>
    </FormWrapper>
  );
};
