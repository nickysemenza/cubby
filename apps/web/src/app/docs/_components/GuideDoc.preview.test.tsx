import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import journey from "../../../../../../docs/product-identity-journey.md?raw";
import { GuideDoc } from "./GuideDoc";

afterEach(() => vi.unstubAllGlobals());

it("renders the journey guide's flowcharts and sequence diagram in Chromium", async () => {
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
});
