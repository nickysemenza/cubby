import type { CompactRecipe } from "~/codec/codec";

export const exampleRecipesCompact: CompactRecipe[] = [
  {
    name: "Pancakes",
    sections: [
      {
        ingredients: ["1 cup flour", "1 cup milk", "1 egg"],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
  },
  {
    name: "Pancakes 2",
    sections: [
      {
        ingredients: [
          "1/2 cup flour",
          "100g flour",
          "1/3 cup milk",
          "2 eggs",
          "1 tsp salt",
          "100g white sugar",
          "1 tsp baking powder",
        ],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
  },
  {
    name: "Scrambled Eggs",
    sections: [
      {
        ingredients: ["2 eggs", "1 tbsp butter"],
        instructions: ["Melt butter in pan", "Scramble eggs in pan"],
      },
    ],
  },
  {
    name: "Breakfast tacos",
    sections: [
      {
        ingredients: [
          "2 eggs",
          "1 tsp oil",
          "1 tsp salt",
          "1 tsp pepper, ground",
        ],
        instructions: ["scramble eggs with salt and pepepr"],
      },
      {
        ingredients: ["1 tortilla"],
        instructions: ["heat tortillas in pan", "fill with eggs"],
      },
      {
        ingredients: ["1 tbsp salsa", "1 tbsp cilantro"],
        instructions: ["top with salsa, hot sauce, cilantro"],
      },
    ],
  },
];
