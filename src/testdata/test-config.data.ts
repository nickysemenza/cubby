import { DataConfig, InfLocationConfig } from "~/schemas/config";
import {
  genericProduct,
  locationWithProductReferences,
  productGenericIngredient,
  productReference,
} from "./data-helpers";
import { uvp } from "./data-helpers";
import {
  productIngredient,
  locationWithProducts,
  product,
} from "./data-helpers";
import { locationWithChildren } from "./data-helpers";

const flourDensity = uvp(1, "cup", 120, "g", "unk");

const garage: InfLocationConfig = locationWithChildren("garage", "room", [
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
const house: InfLocationConfig = locationWithChildren("house", "room", [
  locationWithChildren("kitchen", "room", [
    locationWithProductReferences("fridge", "cabinet", [
      productReference("cilantro"),
      productReference("white sugar"),
    ]),
  ]),
]);
const locations: InfLocationConfig[] = [garage, house];

export const testConfig: DataConfig = {
  locations,
  products: [
    productGenericIngredient("cilantro", undefined, [
      uvp(1, "bunch", 2, "dollars", "whole foods"),
      uvp(1, "bunch", 100, "sprig", "general"),
      uvp(1, "bunch", 1, "each", "general"),
    ]),
    productGenericIngredient("white sugar", undefined, [
      uvp(1, "lb", 1, "dollars", "general"),
    ]),
    productIngredient("All Purpose Flour", "071012010509", "King Arthur", [
      uvp(5, "lb", 8, "dollars", "whole foods"),
      flourDensity,
    ]),
    productIngredient("All Purpose Flour", "039978533012", "Bob's Red Mill", [
      uvp(5, "lb", 7, "dollars", "whole foods"),
      flourDensity,
    ]),
    product("M18 Hackzall", "045242502776", "Milwaukee", "2719-20", 169),
  ],
  aliases: {
    "all purpose flour": [
      "AP flour",
      "flour",
      "white flour",
      "all-purpose flour",
    ],
  },
};
