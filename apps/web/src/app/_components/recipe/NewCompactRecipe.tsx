import { zodResolver } from "@hookform/resolvers/zod";
import type { WIngredient } from "@recipehub/recipebridge";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import React, { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import type { CompactRecipe } from "~/codec/codec";
import { Button } from "~/components/ui/button";
import useDebounce from "~/hooks/useDebounce";
import { queryKeys } from "~/lib/query-keys";
import { wasm } from "~/lib/wasm";
import { dedupe } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";
import { CreateIngredientDialog } from "../combobox/with-search-hook";
import {
  FormWrapper,
  RequiredTextareaField,
  UnifiedTextField,
} from "../form-utils";
import { formatRichText } from "./richtext";

const cleanupLinesToArray = (lines: string) =>
  lines
    .split("\n")
    .map((line) => line.trim())
    .filter((l) => l.length > 0);

// Form schema for recipe
const formSchema = z.object({
  url: z.url("Please enter a valid URL"),
  name: z.string().min(1, "Name is required"),
  ingredientsText: z.string().min(1, "Ingredients are required"),
  instructionsText: z.string().min(1, "Instructions are required"),
});

type RecipeFormValues = z.infer<typeof formSchema>;

const NewCompactRecipe: React.FC = () => {
  const api = useTRPC();
  const navigate = useNavigate();

  // Initialize form
  const form = useForm<RecipeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      url: "https://cooking.nytimes.com/recipes/1022674-chewy-gingerbread-cookies",
      name: "",
      ingredientsText: "",
      instructionsText: "",
    },
  });

  const { watch } = form;
  const ingredientsText = watch("ingredientsText");
  const instructionsText = watch("instructionsText");

  // Debounce both text inputs to reduce parsing frequency
  const debouncedIngredientsText = useDebounce(ingredientsText, 200);
  const debouncedInstructionsText = useDebounce(instructionsText, 200);

  // Parse ingredient lines only when debounced text changes
  const ingredientLines = useMemo(
    () => cleanupLinesToArray(debouncedIngredientsText),
    [debouncedIngredientsText],
  );

  // Parse ingredients only when lines change
  const ingredientsParsed = useMemo(
    () => ingredientLines.map((line) => wasm.parse_ingredient(line)),
    [ingredientLines],
  );

  // Extract names only when parsed ingredients change
  const ingredientNames = useMemo(
    () => ingredientsParsed.map((ingredient) => ingredient.name),
    [ingredientsParsed],
  );

  // Parse instruction lines only when debounced text changes
  const instructionLines = useMemo(
    () => cleanupLinesToArray(debouncedInstructionsText),
    [debouncedInstructionsText],
  );

  // Check if any ingredients are missing from the database
  // Only run queries after debounce has settled to reduce database load
  const debouncedIngredientNames = useDebounce(ingredientNames, 500);
  const uniqueIngredientNames = dedupe(debouncedIngredientNames);

  const ingredientQueries = useQueries({
    queries: uniqueIngredientNames.map((name) => ({
      ...api.ingredient.getByName.queryOptions({
        nameFilter: name,
      }),
      staleTime: 30000, // Increase staleTime to reduce refetching
      enabled: name.length > 0, // Only run query if name is not empty
    })),
  });

  const missingIngredients = useMemo(() => {
    // Create a map of ingredient names to their existence status
    const existenceMap = new Map();
    uniqueIngredientNames.forEach((name, index) => {
      if (name && !ingredientQueries[index].isLoading) {
        existenceMap.set(name, !!ingredientQueries[index].data);
      }
    });

    // Filter ingredient names based on this map
    return ingredientNames.filter(
      (name) =>
        name.length > 0 && existenceMap.has(name) && !existenceMap.get(name),
    );
  }, [ingredientNames, uniqueIngredientNames, ingredientQueries]);

  const scrape = useMutation(api.recipe.scrape.mutationOptions());
  const onScrape = async () => {
    const url = form.getValues("url");
    const res = await scrape.mutateAsync(url);
    if (res?.sections[0]) {
      form.setValue("name", res.name);
      form.setValue("ingredientsText", res.sections[0].ingredients.join("\n"));
      form.setValue(
        "instructionsText",
        res.sections[0].instructions.join("\n"),
      );
    }
  };

  const insert = useMutation(api.recipe.insertCompact.mutationOptions());
  const onSubmit = async (values: RecipeFormValues) => {
    const compact: CompactRecipe = {
      name: values.name,
      meta: { url: values.url },
      sections: [
        {
          ingredients: cleanupLinesToArray(values.ingredientsText),
          instructions: cleanupLinesToArray(values.instructionsText),
        },
      ],
    };
    const res = await insert.mutateAsync(compact);
    toast.success(`Recipe ${values.name} created`);
    navigate({ to: `/recipes/${res.id}` });
  };

  return (
    <FormWrapper
      form={form}
      onSubmit={onSubmit}
      isPending={scrape.isPending || insert.isPending}
      submitButtonText="Create Recipe"
      submitButtonVariant={
        missingIngredients.length > 0 ? "destructive" : "default"
      }
    >
      <div className="my-4">
        <UnifiedTextField
          form={form}
          name="url"
          label="Recipe URL"
          placeholder="Enter recipe URL"
        />
        <Button type="button" onClick={() => onScrape()}>
          Scrape
        </Button>
      </div>

      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder="Enter recipe name"
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <RequiredTextareaField
            form={form}
            name="ingredientsText"
            label="Ingredients"
            placeholder="Enter your recipe here..."
          />
          {missingIngredients.length > 0 && (
            <MissingIngredientsList missingIngredients={missingIngredients} />
          )}
        </div>
        <div>
          {ingredientsParsed.map((l, x) => (
            <div key={`${l.name}${x}`}>
              <RenderWIngredient amount={l} />
            </div>
          ))}
        </div>
      </div>

      <hr className="my-4" />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RequiredTextareaField
          form={form}
          name="instructionsText"
          label="Instructions"
          placeholder="Enter your instructions here..."
        />
        <div>
          <ol className="list-decimal pl-5 leading-relaxed">
            <RichTextInstructions
              instructionLines={instructionLines}
              ingredientNames={ingredientNames}
            />
          </ol>
        </div>
      </div>
    </FormWrapper>
  );
};

// Component to memoize rich text parsing for instructions
const RichTextInstructions = React.memo(function RichTextInstructions({
  instructionLines,
  ingredientNames,
}: {
  instructionLines: string[];
  ingredientNames: string[];
}) {
  // Memoize the rich text parsing results to prevent recalculation on each render
  const parsedInstructions = useMemo(() => {
    // Parse all instructions at once
    return instructionLines.map((line) =>
      formatRichText(wasm.parse_rich_text(line, ingredientNames)),
    );
  }, [instructionLines, ingredientNames]);

  return (
    <>
      {parsedInstructions.map((content, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: instructionLines are plain strings without stable IDs
        <li key={idx}>{content}</li>
      ))}
    </>
  );
});

const IngredientByName = React.memo(function IngredientByName({
  name,
}: {
  name: string;
}) {
  const api = useTRPC();

  // Don't query for empty names
  const itemsResp = useQuery({
    ...api.ingredient.getByName.queryOptions({
      nameFilter: name,
    }),
    staleTime: 30000, // Increase staleTime to reduce refetching
    enabled: name.length > 0, // Only run query if name is not empty
  });

  const resultName = itemsResp.data?.name;

  return (
    <div className={resultName ? "inline underline" : "inline"}>
      {resultName ?? name}
    </div>
  );
});

const MissingIngredientsList: React.FC<{ missingIngredients: string[] }> = ({
  missingIngredients,
}) => {
  const api = useTRPC();
  const queryClient = useQueryClient();

  // State for the ingredient creation dialog
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedIngredient, setSelectedIngredient] = useState("");

  // Mutation for creating ingredients
  const createIngredient = useMutation(
    api.ingredient.create.mutationOptions({
      onSuccess: () => {
        // Invalidate ingredient queries to refetch and update the missing ingredients list
        // This will refetch all ingredient.getByName queries which will update our missing ingredients list
        queryClient.invalidateQueries({
          queryKey: queryKeys.ingredient.getByName,
        });
        toast.success("Ingredient created successfully!");
        setIsDialogOpen(false);
      },
    }),
  );

  const handleOpenDialog = (name: string) => {
    setSelectedIngredient(name);
    setIsDialogOpen(true);
  };

  if (missingIngredients.length === 0) {
    return null;
  }

  return (
    <>
      <CreateIngredientDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={() => setIsDialogOpen(false)}
        onCreate={(data) => {
          createIngredient.mutate(data);
        }}
        isPending={createIngredient.isPending}
        error={createIngredient.error?.message}
        initialName={selectedIngredient}
      />

      <div className="mt-4 rounded border border-border bg-muted p-3">
        <h3 className="mb-2 font-medium text-foreground">
          Missing Ingredients
        </h3>
        <div className="mb-2 text-muted-foreground text-sm">
          These ingredients don&apos;t exist in your database yet:
        </div>
        <ul className="space-y-1">
          {missingIngredients.map((name) => (
            <li
              key={`missing-${name}`}
              className="flex items-center justify-between"
            >
              <span>{name}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="py-1 text-xs"
                onClick={() => handleOpenDialog(name)}
                disabled={createIngredient.isPending}
              >
                Create
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
};

const RenderWIngredient: React.FC<{ amount: WIngredient }> = ({ amount }) => {
  const amounts = amount.amounts;

  // Memoize formatted amount values
  const formattedAmounts = useMemo(() => {
    return amounts.map((a) => wasm.format_amount_value(a));
  }, [amounts]);

  return (
    <div className="inline">
      <div className="inline">
        {amounts.map((a, x) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: amounts array items don't have stable IDs
          <div key={x} className="inline">
            <div className="inline pr-1 text-primary">
              {formattedAmounts[x]}
            </div>
            <div className="inline text-accent-foreground">{a.unit}</div>
            {x < amounts.length - 1 && <div className="inline"> / </div>}
          </div>
        ))}
      </div>
      <div className="inline pl-2 text-foreground">
        <IngredientByName name={amount.name} />
      </div>
      {amount.modifier && (
        <div className="inline">
          {", "}
          <div className="inline text-muted-foreground italic">
            {amount.modifier}
          </div>
        </div>
      )}
    </div>
  );
};

export default NewCompactRecipe;
