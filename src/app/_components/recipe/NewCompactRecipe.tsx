"use client";
import React, { useMemo } from "react";
import { type WIngredient } from "recipebridge/pkg";
import { useTRPC } from "~/trpc/react";
import { type CompactRecipe } from "~/codec/codec";
import { Button } from "~/components/ui/button";
import { formatRichText } from "./richtext";
import useDebounce from "../../../misc/useDebounce";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useWasm } from "~/wasmContext";
import { useMutation } from "@tanstack/react-query";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  FormWrapper,
  RequiredTextareaField,
  UnifiedTextField,
} from "../form-utils";
import { CreateIngredientDialog } from "../combobox/with-search-hook";
import { useState } from "react";

const cleanupLinesToArray = (lines: string) =>
  lines
    .split("\n")
    .map((line) => line.trim())
    .filter((l) => l.length > 0);

// Form schema for recipe
const formSchema = z.object({
  url: z.string().url("Please enter a valid URL"),
  name: z.string().min(1, "Name is required"),
  ingredientsText: z.string().min(1, "Ingredients are required"),
  instructionsText: z.string().min(1, "Instructions are required"),
});

type RecipeFormValues = z.infer<typeof formSchema>;

const NewCompactRecipe: React.FC = () => {
  const api = useTRPC();
  const { w } = useWasm();
  const router = useRouter();

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

  const debouncedText = useDebounce(ingredientsText, 300);
  const ingredientLines = useMemo(
    () => cleanupLinesToArray(debouncedText),
    [debouncedText],
  );

  const ingredientsParsed = useMemo(
    () => (w ? ingredientLines.map((line) => w.parse_ingredient(line)) : []),
    [ingredientLines, w],
  );

  const ingredientNames = useMemo(
    () => ingredientsParsed.map((ingredient) => ingredient.name),
    [ingredientsParsed],
  );

  const instructionLines = useMemo(
    () => cleanupLinesToArray(instructionsText),
    [instructionsText],
  );

  // Check if any ingredients are missing from the database
  const ingredientQueries = useQueries({
    queries: ingredientNames.map((name) => ({
      ...api.ingredient.getByName.queryOptions({
        nameFilter: name,
      }),
      staleTime: 10000,
    })),
  });

  const missingIngredients = useMemo(() => {
    return ingredientNames.filter(
      (name, index) =>
        !ingredientQueries[index].isLoading && !ingredientQueries[index].data,
    );
  }, [ingredientNames, ingredientQueries]);

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
    router.push(`/recipes/${res.id}`);
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
            {instructionLines.map((line, x) => (
              <li key={x + "2"}>
                {w &&
                  formatRichText(
                    w,
                    w.parse_rich_text(
                      line,
                      ingredientsParsed.map((l) => l.name),
                    ),
                  )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </FormWrapper>
  );
};

const IngredientByName: React.FC<{ name: string }> = ({ name }) => {
  const api = useTRPC();
  const itemsResp = useQuery(
    api.ingredient.getByName.queryOptions({
      nameFilter: name,
    }),
  );
  const resultName = itemsResp.data?.name;
  return (
    <div className={resultName ? "inline underline" : "inline"}>
      {resultName ?? name}
    </div>
  );
};

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
          queryKey: ["ingredient", "getByName"],
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

      <div className="mt-4 rounded border border-orange-200 bg-orange-50 p-3">
        <h3 className="mb-2 font-medium text-orange-800">
          Missing Ingredients
        </h3>
        <div className="mb-2 text-sm text-orange-700">
          These ingredients don&apos;t exist in your database yet:
        </div>
        <ul className="space-y-1">
          {missingIngredients.map((name, index) => (
            <li
              key={`missing-${index}`}
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
  const { w } = useWasm();
  return (
    <div className="inline">
      <div className="inline">
        {amounts.map((a, x) => (
          <div key={x} className="inline">
            <div className="inline text-blue-600">
              {w && w.format_measure_value(a)}
            </div>
            <div className="inline text-green-800">{a.unit}</div>
            {x < amounts.length - 1 && <div className="inline"> / </div>}
          </div>
        ))}
      </div>
      <div className="inline pl-2 text-orange-800">
        <IngredientByName name={amount.name} />
      </div>
      {amount.modifier && (
        <div className="inline">
          {", "}
          <div className="inline text-gray-400 italic">{amount.modifier}</div>
        </div>
      )}
    </div>
  );
};

export default NewCompactRecipe;
