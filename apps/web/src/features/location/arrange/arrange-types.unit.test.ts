import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import * as arrange from "./arrange-types";

const locationId = testShortcode("location", "shelf");
const inventoryEntryId = testShortcode("inventory", "item");
const wrongEntity = testShortcode("product", "wrong-entity");

// Invalid or cross-entity drag payloads must not reach location/inventory mutations.
describe("drag-and-drop ingress parsing", () => {
  it.each([
    {
      surface: "arrange drag",
      parse: arrange.asDragData,
      accepted: {
        arrangeDrag: "item",
        inventoryEntryId,
        amount: { value: 2, unit: "each" },
        sourceLocationId: locationId,
      },
      refused: {
        arrangeDrag: "location",
        locationId: wrongEntity,
        parentId: null,
      },
    },
    {
      surface: "arrange drop",
      parse: arrange.asDropData,
      accepted: { arrangeTarget: true, locationId },
      refused: { arrangeTarget: true, locationId: "not-a-shortcode" },
    },
  ])(
    "$surface keeps branded ids and refuses cross-entity ones",
    ({ parse, accepted, refused }) => {
      expect(parse(accepted)).toEqual(accepted);
      expect(parse(refused)).toBeNull();
    },
  );
});
