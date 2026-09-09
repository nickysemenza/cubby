import { expect, it } from "vitest";

import { appendGraphImages } from "./dependency-graph-images";

it("adds a bounded thumbnail without replacing the record label, and removes failed images", () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.innerHTML =
    '<g class="node"><title>product:PRD-TEST</title><polygon/><text>Example product</text></g>';
  const polygon = svg.querySelector("polygon")!;
  Object.defineProperty(polygon, "getBBox", {
    value: () => ({ x: 10, y: 20, width: 240, height: 80 }),
  });
  appendGraphImages(svg, [
    { id: "product:PRD-TEST", url: "https://example.com/cover.png" },
  ]);
  const image = svg.querySelector("image")!;
  expect(image.getAttribute("href")).toBe("https://example.com/cover.png");
  expect(image.getAttribute("width")).toBe("56");
  expect(image.getAttribute("x")).toBe("26");
  expect(image.getAttribute("y")).toBe("32");
  expect(image.getAttribute("pointer-events")).toBe("none");
  image.dispatchEvent(new Event("error"));
  expect(svg.querySelector("image")).toBeNull();
  expect(svg.querySelector("text")?.textContent).toBe("Example product");
});
