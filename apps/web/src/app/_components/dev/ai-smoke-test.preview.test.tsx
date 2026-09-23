import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { smokeCatalog } from "~/server/ai/smoke-catalog";

import { AiSmokeTest } from "./ai-smoke-test";

describe("AI smoke page layout", () => {
  it.each([
    ["phone", 402, 874],
    ["desktop", 1440, 900],
  ] as const)(
    "keeps cards and controls within the %s viewport",
    async (_label, width, height) => {
      await page.viewport(width, height);
      const queryClient = new QueryClient();
      const { container } = render(
        <QueryClientProvider client={queryClient}>
          <AiSmokeTest
            operations={{
              catalog: async () => smokeCatalog(),
              run: async () => {
                throw new Error("No model call in layout verification");
              },
            }}
          />
        </QueryClientProvider>,
      );
      expect(
        await screen.findByRole("heading", { name: "Embeddings" }),
      ).toBeInTheDocument();
      expect(container.scrollWidth).toBeLessThanOrEqual(width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(screen.getAllByRole("button", { name: "Run" })).toHaveLength(23);
    },
  );
});
