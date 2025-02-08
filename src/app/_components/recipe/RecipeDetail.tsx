"use client";

import React from "react";
import { JsonEditor } from "json-edit-react";
import { type RecipeOut } from "~/schemas/recipes";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  return (
    <div>
      <h1>Recipe Detail</h1>
      <JsonEditor data={recipe} />
    </div>
  );
};

export default RecipeDetail;
