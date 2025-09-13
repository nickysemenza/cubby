import { DataConfig, InfLocationConfigInput } from "~/schemas/config";
import {
  genericProduct,
  locationWithProductReferences,
  productGenericIngredient,
  productReference,
} from "./data-helpers";
import {
  productIngredient,
  locationWithProducts,
  product,
} from "./data-helpers";
import { locationWithChildren } from "./data-helpers";

const flourDensity = "1 cup = 120g @ unk";

const garage: InfLocationConfigInput = locationWithChildren("garage", "room", [
  locationWithChildren("shelf", "shelf", [
    locationWithProducts("oscillating and grinder", "half-crate", [
      product("Ryobi Angle Grinder", "033287188048", "Ryobi", "PBLAG01B", 129),
      product(
        "Ryobi Oscillating Tool",
        "033287190706",
        "Ryobi",
        "PBLMT50B",
        129,
      ),
      genericProduct("angle grinder discs", 4),
      genericProduct("oscillating toolblades", 8),
    ]),

    locationWithProducts("bin B", "crate"),
    locationWithProducts("bin C", "crate"),
  ]),
]);
const house: InfLocationConfigInput = locationWithChildren("house", "room", [
  locationWithChildren("kitchen", "room", [
    locationWithProductReferences("fridge", "cabinet", [
      productReference("cilantro"),
      productReference("white sugar"),
    ]),
  ]),
]);
const locations: InfLocationConfigInput[] = [garage, house];

export const testConfig: DataConfig = {
  locations,
  products: [
    productGenericIngredient("cilantro", undefined, [
      "1 bunch = $2 @ whole foods",
      "1 bunch = 100sprig @ general",
      "1 bunch = 1each @ general",
    ]),
    productGenericIngredient("white sugar", undefined, ["1 lb = $1 @ general"]),
    productIngredient(
      "All Purpose Flour",
      "071012010509",
      "King Arthur",
      ["5 lb = $8 @ whole foods", flourDensity],
      ["AP flour", "flour", "white flour", "all-purpose flour"],
    ),
    productIngredient(
      "All Purpose Flour",
      "039978533012",
      "Bob's Red Mill",
      ["5 lb = $7 @ whole foods", flourDensity],
      ["AP flour", "flour", "white flour", "all-purpose flour"],
    ),
    product("M18 Hackzall", "045242502776", "Milwaukee", "2719-20", 169),
  ],
};
