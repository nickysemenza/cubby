import { expect, test } from "vitest";
import { classifyMalformedIngredientName } from "./problems";

// Real mangled names found in prod (parser-audit) — must be flagged.
test.each([
  "very chives",
  "coarsely pecans",
  "recipes Flaky All-Butter Pie Dough",
  "loaf baked Brioche",
  "sprigs fresh thyme",
  "pieces Soft and Pillowy Flatbread dough",
  "Recipe: The Only Piecrust",
  "medium",
  "small Yukon Gold and",
  "pecan or walnut pieces and",
  "2 (3-inch) cinnamon sticks or ½ teaspoon ground cinnamon",
  "cinnamon stick or ¼ teaspoon ground cinnamon",
])("flags malformed: %s", (name) => {
  expect(classifyMalformedIngredientName(name)).not.toBeNull();
});

// Legitimate names the parser intentionally produces — must NOT be flagged
// (size words, real "X or Y" alternatives, leading adverb + real prep verb).
test.each([
  "all-purpose flour",
  "medium yellow onion",
  "large eggs",
  "finely grated lemon zest",
  "finely ground black pepper",
  "amaretto or dark rum",
  "fresh or frozen blueberries",
  "Chinese 5-spice powder",
  "garlic clove",
  "Butter for the pan",
  "extra-virgin olive oil",
])("allows valid: %s", (name) => {
  expect(classifyMalformedIngredientName(name)).toBeNull();
});
