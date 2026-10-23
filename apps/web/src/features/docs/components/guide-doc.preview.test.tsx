import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import journey from "../../../../../../docs/guide/product-identity-journey.md?raw";
import { GuideDoc } from "./guide-doc";

afterEach(() => vi.unstubAllGlobals());

it("renders the journey diagrams without clipping node labels", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, text: async () => journey }),
  );

  render(
    <GuideDoc
      sourcePath="product-identity-journey.md"
      sourceUrl="/assets/product-identity-journey.md"
    />,
  );

  await waitFor(() =>
    expect(
      screen.getAllByRole("figure", { name: "Mermaid diagram" }),
    ).toHaveLength(3),
  );
  const diagrams = screen.getAllByRole("figure", { name: "Mermaid diagram" });
  expect(diagrams).toHaveLength(3);
  expect(diagrams.every((diagram) => diagram.querySelector("svg"))).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  for (const diagram of diagrams) {
    expect(diagram.querySelectorAll("svg text").length).toBeGreaterThan(0);
  }

  for (const width of [1440, 402]) {
    await page.viewport(width, 900);
    const clippedLabels = diagrams.flatMap((diagram) =>
      Array.from(diagram.querySelectorAll("svg text")).flatMap((label) => {
        const svg = label.closest("svg");
        if (!svg) return [];
        const box = svg.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        if (
          text.top >= box.top - 1 &&
          text.bottom <= box.bottom + 1 &&
          text.left >= box.left - 1 &&
          text.right <= box.right + 1
        ) {
          return [];
        }
        return [{ label: label.textContent }];
      }),
    );
    expect(clippedLabels, `clipped labels at ${width}px`).toEqual([]);
  }
});
