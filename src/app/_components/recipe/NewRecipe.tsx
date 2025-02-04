"use client";

import React, { useState, useMemo } from "react";
import {
  parse_ingredient,
  type WIngredient,
  parse_rich_text,
} from "recipebridge/pkg/recipebridge";
import { api } from "~/trpc/react";
import { getIngredientUnit } from "./utils";
import { twMerge } from "tailwind-merge";
import { type CompactRecipe } from "~/codec/codec";
import { Button } from "../Button";
import { formatRichText } from "./richtext";
import useDebounce from "../useDebounce";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
const cleanupLinesToArray = (lines: string) =>
  lines
    .split("\n")
    .map((line) => line.trim())
    .filter((l) => l.length > 0);
const NewRecipe: React.FC = () => {
  const [url, setURL] = useState<string>(
    "https://cooking.nytimes.com/recipes/1022674-chewy-gingerbread-cookies",
  );
  const [name, setName] = useState<string>("");
  const [ingredientsText, setIngredients] = useState<string>("");
  const [instructionsText, setInstructions] = useState<string>("");
  const router = useRouter();

  const debouncedText = useDebounce(ingredientsText, 300);
  const ingredientLines = useMemo(
    () => cleanupLinesToArray(debouncedText),
    [debouncedText],
  );

  const ingredientsParsed = useMemo(
    () => ingredientLines.map((line) => parse_ingredient(line)),
    [ingredientLines],
  );

  const instructionLines = useMemo(
    () => cleanupLinesToArray(instructionsText),
    [instructionsText],
  );
  const scrape = api.recipe.scrape.useMutation();
  const onScrape = async () => {
    const res = await scrape.mutateAsync(url);
    if (res?.sections[0]) {
      setName(res.name);
      setIngredients(res.sections[0].ingredients.join("\n"));
      setInstructions(res.sections[0].instructions.join("\n"));
    }
  };
  const insert = api.recipe.insertCompact.useMutation();
  const onCreate = async () => {
    const compact: CompactRecipe = {
      name,
      sections: [
        {
          ingredients: ingredientLines,
          instructions: instructionLines,
        },
      ],
    };
    const res = await insert.mutateAsync(compact);
    toast(`Recipe ${name} created`, { type: "success" });
    router.push(`/recipes/${res.id}`);
  };

  return (
    <div className="container mx-auto">
      <div className="my-4">
        <input
          className="w-1/2 rounded-md border-2"
          value={url}
          onChange={(e) => setURL(e.target.value)}
        />
        <Button onPress={() => onScrape()}>Scrape</Button>
      </div>
      <input
        className="w-100 rounded-md border-2"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <textarea
          value={ingredientsText}
          onChange={(e) => setIngredients(e.target.value)}
          rows={10}
          cols={50}
          placeholder="Enter your recipe here..."
          className="border border-gray-300"
        />
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
        <textarea
          value={instructionsText}
          onChange={(e) => setInstructions(e.target.value)}
          rows={10}
          cols={50}
          placeholder="Enter your instructions here..."
          className="border border-gray-300 leading-relaxed"
        />
        <div>
          <ol className="list-decimal pl-5 leading-relaxed">
            {instructionLines.map((line, x) => (
              <li key={x + "2"}>
                {formatRichText(
                  parse_rich_text(
                    line,
                    ingredientsParsed.map((l) => l.name),
                  ),
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
      {/* <JsonRenderer input={{ lines, linesParsed }} /> */}
      <Button onPress={() => onCreate()}>Create</Button>
    </div>
  );
};
const IngredientByName: React.FC<{ name: string }> = ({ name }) => {
  const itemsResp = api.item.getByName.useQuery({
    itemTypeFilter: "Ingredient",
    nameFilter: name,
  });
  const resultName = itemsResp.data?.name;
  return (
    <div className={twMerge(`inline`, resultName && "underline")}>
      {resultName ?? name}
    </div>
  );
};

const RenderWIngredient: React.FC<{ amount: WIngredient }> = ({ amount }) => {
  const amounts = amount.amounts;
  return (
    <div className="inline">
      <div className="inline">
        {amounts.map((a, x) => (
          <div key={getIngredientUnit(a)} className="inline">
            <div className="inline text-blue-600">{a.value}</div>{" "}
            <div className="inline text-green-800">{getIngredientUnit(a)}</div>
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

export default NewRecipe;
