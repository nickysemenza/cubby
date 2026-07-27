import type {
  IngredientUpdateInput,
  IngredientWithRecipesAndProductOut,
  ingredientBase,
} from "@cubby/schemas/ingredient";
import { zodResolver } from "@hookform/resolvers/zod";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { type Control, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { AliasesField, filterAliases } from "~/components/forms/aliases-field";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { useTRPC } from "~/integrations/trpc/react";
import { EntityInlineLink } from "../EntityInlineLink";
import {
  buildUpdateObject,
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  getSubmitButtonText,
  submitOrCancel,
  UnifiedTextField,
} from "../form-utils";

// Form schema for ingredient
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  aliases: z.array(z.string()),
});

type IngredientFormValues = z.infer<typeof formSchema>;

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
  const api = useTRPC();
  const name = useWatch({ control, name: "name" });
  const [debouncedName] = useDebouncedValue(name, { wait: 300 });
  const trimmed = debouncedName?.trim() ?? "";
  const enabled = trimmed.length >= 2;

  const { data } = useQuery({
    ...api.ingredient.list.queryOptions({
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
      <Description size="xs" className={exact ? "text-warning" : undefined}>
        {exact
          ? "An ingredient with this name already exists — did you mean to use it?"
          : "Similar ingredients already exist. Use one of these instead of creating a duplicate?"}
      </Description>
      <Row gap="xs" wrap>
        {matches.map((m) => (
          <EntityInlineLink
            key={m.id}
            entity="ingredient"
            data={{ name: m.name, id: m.id }}
          />
        ))}
      </Row>
    </Stack>
  );
}

// Props for create mode
interface CreateIngredientFormProps
  extends CreateModeProps<z.infer<typeof ingredientBase>> {
  ingredient?: never;
  initialName?: string;
}

// Props for edit mode
interface EditIngredientFormProps
  extends EditModeProps<
    IngredientUpdateInput,
    IngredientWithRecipesAndProductOut
  > {
  entity: IngredientWithRecipesAndProductOut;
}

// Combined props type
type IngredientFormProps = CreateIngredientFormProps | EditIngredientFormProps;

export const IngredientForm: FC<IngredientFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const ingredient = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form
  const form = useForm<IngredientFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: ingredient ? ingredient.name : (initialName ?? ""),
      aliases: ingredient ? ingredient.aliases : [],
    },
  });

  const handleSubmit = (values: IngredientFormValues) => {
    // Filter out empty alias strings
    const filteredAliases = filterAliases(values.aliases);

    if (mode === "create") {
      // For creation, pass all fields
      // Get current date for timestamps (will be replaced by server)
      const createData: z.infer<typeof ingredientBase> = {
        name: values.name,
        aliases: filteredAliases,
      };
      props.onCreate(createData);
    } else if (mode === "edit" && ingredient) {
      // In edit mode, determine which fields have changed
      const updatedValues = {
        ...values,
        aliases: filteredAliases,
      };

      const updates = buildUpdateObject(ingredient, updatedValues, [
        "name",
        "aliases",
      ]);

      submitOrCancel(
        updates,
        () => ({ id: ingredient.id, data: updates }),
        props.onEdit,
        onCancel,
      );
    }
  };

  const buttonText = getSubmitButtonText(mode);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <Card>
        <CardContent className="px-4 py-1">
          <UnifiedTextField
            form={form}
            name="name"
            label="Name"
            placeholder="Enter ingredient name"
            nullable={false}
          />
        </CardContent>
        {mode === "create" && <DuplicateNameHint control={form.control} />}
      </Card>

      <AliasesField<IngredientFormValues> form={form} />
    </FormWrapper>
  );
};
