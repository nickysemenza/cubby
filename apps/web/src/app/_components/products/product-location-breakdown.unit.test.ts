import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  buildProductLocationBreakdown,
  type ProductLocationBreakdownInput,
} from "./product-location-breakdown";

const loc = (
  id: string,
  name: string,
  ancestors: ProductLocationBreakdownInput["servingAsLocations"][number]["ancestors"] = [],
  displayImage: { url: string } | null = null,
) => ({
  id: unsafeLocationShortcode(id),
  name,
  type: "area" as const,
  displayImage,
  ancestors,
});

const entry = (
  id: string,
  name: string,
  value: number,
  ancestors: ProductLocationBreakdownInput["servingAsLocations"][number]["ancestors"],
  unit = "each",
): ProductLocationBreakdownInput["inventoryEntry"][number] => ({
  amount: { value, unit },
  placement: "stock",
  location: loc(id, name, ancestors),
});

const child = (
  node: NonNullable<ReturnType<typeof buildProductLocationBreakdown>>,
  label: string,
) => node.children?.find((candidate) => candidate.label === label);

describe("buildProductLocationBreakdown", () => {
  it("focuses the shared ancestor and reconciles direct stock with descendant identities", () => {
    const home = loc("LOC-HOME", "Home");
    const workshop = loc("LOC-WORK", "Workshop", [home]);
    const kitchen = loc("LOC-KITC", "Kitchen", [home]);
    const upper = loc("LOC-UPPR", "Upper zone", [home, workshop]);
    const wall = loc("LOC-WALL", "Wall storage", [home, workshop, upper]);
    const stackA = loc("LOC-STKA", "Stack A", [home, workshop, upper, wall]);
    const stackB = loc("LOC-STKB", "Stack B", [home, workshop, upper, wall]);

    const result = buildProductLocationBreakdown({
      inventoryEntry: [
        entry("LOC-WALL", "Wall storage", 3, [home, workshop, upper]),
      ],
      servingAsLocations: [
        ...Array.from({ length: 4 }, (_, index) =>
          loc(`LOC-A00${index}`, `A ${index}`, [
            home,
            workshop,
            upper,
            wall,
            stackA,
          ]),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          loc(`LOC-B00${index}`, `B ${index}`, [
            home,
            workshop,
            upper,
            wall,
            stackB,
          ]),
        ),
        loc("LOC-KBIN", "Kitchen bin", [home, kitchen]),
        loc("LOC-KBOX", "Kitchen box", [home, kitchen]),
      ],
    });

    expect(result).toMatchObject({ label: "Home", metricLabel: "12 each" });
    expect(child(result!, "Workshop")).toMatchObject({
      metricLabel: "10 each",
    });
    expect(child(result!, "Kitchen")).toMatchObject({ metricLabel: "2 each" });

    const workshopNode = child(result!, "Workshop")!;
    const upperNode = child(workshopNode, "Upper zone")!;
    const wallNode = child(upperNode, "Wall storage")!;
    expect(wallNode).toMatchObject({
      metricLabel: "10 each",
      directMetricLabel: "3 each",
      annotations: ["stock"],
    });
    expect(child(wallNode, "Stack A")).toMatchObject({
      metricLabel: "4 each",
    });
    expect(child(wallNode, "Stack B")).toMatchObject({
      metricLabel: "3 each",
    });
  });

  it("merges duplicate direct placements at one location", () => {
    const home = loc("LOC-HOME", "Home");
    const shelf = loc("LOC-SHLF", "Shelf", [home]);
    const result = buildProductLocationBreakdown({
      inventoryEntry: [
        entry("LOC-SHLF", "Shelf", 2, [home]),
        entry("LOC-SHLF", "Shelf", 3, [home]),
      ],
      servingAsLocations: [shelf],
    });

    expect(result).toMatchObject({
      label: "Shelf",
      metricLabel: "6 each",
      directMetricLabel: "6 each",
      annotations: ["is this location", "stock"],
    });
  });

  it("keeps mixed units separate and disables numeric bar values globally", () => {
    const home = loc("LOC-HOME", "Home");
    const left = loc("LOC-LEFT", "Left", [home]);
    const right = loc("LOC-RGHT", "Right", [home]);
    const result = buildProductLocationBreakdown({
      inventoryEntry: [
        entry("LOC-LEFT", "Left", 2, [home], "each"),
        entry("LOC-RGHT", "Right", 3, [home], "box"),
      ],
      servingAsLocations: [],
    });

    expect(result).toMatchObject({
      label: "Home",
      metricLabel: "3 box + 2 each",
      metricValue: null,
    });
    expect(child(result!, "Left")?.metricValue).toBeNull();
    expect(child(result!, "Right")?.metricValue).toBeNull();
    expect(left.id).not.toBe(right.id);
  });

  it("carries each rung's resolved thumbnail onto its node, and only where one resolved", () => {
    const homeCover = { url: "https://img.test/home.jpg" };
    const rackCover = { url: "https://img.test/rack.jpg" };
    const home = loc("LOC-HOME", "Home", [], homeCover);
    const result = buildProductLocationBreakdown({
      inventoryEntry: [
        entry("LOC-RACK", "Rack", 2, [home]),
        entry("LOC-SHLF", "Shelf", 1, [home]),
      ],
      servingAsLocations: [loc("LOC-RACK", "Rack", [home], rackCover)],
    });

    expect(result).toMatchObject({ label: "Home", displayImage: homeCover });
    // The rack is a bin that IS this product: it has no photo of its own, so
    // the server resolved its SKU's cover. The stock entry for the same
    // location arrives first and carries none — the later rung must still win.
    expect(child(result!, "Rack")?.displayImage).toEqual(rackCover);
    // A location that resolved to nothing omits the key entirely rather than
    // carrying a null, so the mark falls back to the entity icon.
    expect(child(result!, "Shelf")).not.toHaveProperty("displayImage");
  });

  it("returns null for a product with no presence", () => {
    expect(
      buildProductLocationBreakdown({
        inventoryEntry: [],
        servingAsLocations: [],
      }),
    ).toBeNull();
  });
});
