"use client";

import React, { useState, useEffect } from "react";
import JsonRenderer from "../json";
import {
  parse_ingredient,
  WIngredient,
  WMeasure,
  OtherUnitEnum,
} from "recipebridge/pkg/recipebridge";
import { api } from "~/trpc/react";
import { getIngredientUnit } from "./utils";
import { twMerge } from "tailwind-merge";

const NewRecipe: React.FC = () => {
  const [text, setText] = useState<string>("");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((l) => l.length > 0);

  const linesParsed = lines.map((line) => parse_ingredient(line));

  return (
    <div>
      <div className="flex">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          cols={50}
          placeholder="Enter your recipe here..."
        />
        <div>
          {linesParsed.map((l, x) => (
            <div key={`${l.name}${x}`}>
              <RenderWIngredient amount={l} />
            </div>
          ))}
        </div>
      </div>
      <JsonRenderer input={{ lines, linesParsed }} />
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
          <div key={`${a.unit}${x}`} className="inline">
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
          <div className="inline italic text-gray-400">{amount.modifier}</div>
        </div>
      )}
    </div>
  );
};

export default NewRecipe;
