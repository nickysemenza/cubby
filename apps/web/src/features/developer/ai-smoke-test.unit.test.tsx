import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { smokeCatalog } from "~/server/ai/smoke-catalog";

import { AiSmokeTest } from "./ai-smoke-test";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

describe("AI smoke card", () => {
  it("links both successful and failed attempts to their Runs", async () => {
    let attempts = 0;
    const operations = {
      catalog: async () =>
        smokeCatalog().filter((item) => item.id === "purchaseMail"),
      run: async () => {
        attempts += 1;
        return attempts === 1
          ? {
              status: "ok",
              feature: "purchase-import-mail",
              model: "example-model",
              runShortcode: "RUN-2222",
              durationMs: 1250,
              result: { kind: "order" },
            }
          : {
              status: "error",
              feature: "purchase-import-mail",
              model: "example-model",
              runShortcode: "RUN-3333",
              durationMs: 95,
              error: "Gateway rejected the request",
            };
      },
    } satisfies NonNullable<
      NonNullable<ComponentProps<typeof AiSmokeTest>>["operations"]
    >;
    render(<AiSmokeTest operations={operations} />, {
      wrapper: harness.wrapper,
    });
    const button = await screen.findByRole("button", { name: "Run" });
    fireEvent.click(button);
    expect(
      await screen.findByRole("link", { name: "View Run" }),
    ).toHaveAttribute("href", "/runs/RUN-2222");
    expect(screen.getByText("ok · 1.3s")).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "View Run" })).toHaveAttribute(
        "href",
        "/runs/RUN-3333",
      ),
    );
    expect(
      screen.getByText("Gateway rejected the request"),
    ).toBeInTheDocument();
  });
});
