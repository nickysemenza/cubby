type UnitValue = {
  unit: string;
  value: number;
};

type Mapping = [UnitValue, UnitValue];

class Ing {
  constructor(name: string, mappings: Mapping[], aliases: string[] | null) {
    this.mappings = mappings;
    this.name = name;
    this.aliases = aliases;
  }
  public name: string;
  public mappings: Mapping[];
  public aliases: string[] | null;
}

const unitValue = (value: number, unit: string): UnitValue => ({ unit, value });
const unitValuePair = (
  valueA: number,
  unitA: string,
  valueB: number,
  unitB: string,
): Mapping => [unitValue(valueA, unitA), unitValue(valueB, unitB)];
const densityOil = unitValuePair(1, "ml", 0.9, "g");
const densityWater = unitValuePair(1, "ml", 1, "g");
const flourDensity = unitValuePair(1, "cup", 120, "g");

const flours = [
  new Ing(
    "all purpose flour",
    [flourDensity, unitValuePair(8, "dollar", 5, "pound")],
    ["AP flour", "flour", "white flour"],
  ),
  new Ing(
    "bread flour",
    [flourDensity, unitValuePair(8, "dollar", 5, "pound")],
    null,
  ),
  new Ing(
    "pastry flour",
    [flourDensity, unitValuePair(8, "dollar", 5, "pound")],
    null,
  ),
  new Ing(
    "cake flour",
    [flourDensity, unitValuePair(8, "dollar", 5, "pound")],
    null,
  ),
  new Ing(
    "whole wheat flour",
    [flourDensity, unitValuePair(8, "dollar", 5, "pound")],
    null,
  ),
];
const oils = [
  new Ing("olive oil", [densityOil], ["Extra Virgin Olive Oil", "evoo"]),
  new Ing("vegetable oil", [densityOil], null),
  new Ing("canola oil", [densityOil], null),
  new Ing("avocado oil", [densityOil], null),
];

const dairy = [
  new Ing(
    "butter",
    [
      unitValuePair(1, "stick", 113, "g"),
      unitValuePair(4, "stick", 8, "dollars"),
    ],
    null,
  ),
  new Ing("milk", [], null),
  new Ing("egg", [], ["eggs"]),
];
const spices = [
  new Ing("salt", [unitValuePair(1, "tsp", 5, "g")], null),
  new Ing("black pepper", [], null),
];
export const exampleIngredients: Ing[] = [
  new Ing("tortilla", [], null),
  new Ing("cilantro", [], null),
  new Ing("water", [densityWater], null),
  ...spices,
  ...dairy,
  ...flours,
  ...oils,
];
