import { type CompactRecipe } from "~/codec/codec";

export const exampleRecipes: CompactRecipe[] = [
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
    name: "Scrambled Eggs",
    sections: [
      {
        ingredients: ["2 eggs", "1 tbsp butter"],
        instructions: ["Melt butter in pan", "Scramble eggs in pan"],
      },
    ],
  },
];
