import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { detailPage } from "./entity-routes";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("detailPage", () => {
  it("transitions a refetched missing record into route not-found", async () => {
    const Detail = detailPage({
      query: () => ({
        queryKey: ["record"] as const,
        queryFn: async () => null,
      }),
      render: () => <div>record</div>,
      title: () => "Record",
    });
    const browserHarness = createBrowserTestHarness({
      initialPath: "/products/PRD-TEST",
      route: {
        path: "/products/$shortcode",
        component: Detail,
        notFoundComponent: () => <div>Record not found</div>,
      },
    });
    harness = browserHarness;
    browserHarness.queryClient.setQueryData(["record"], null);
    await act(async () => {
      await browserHarness.loadRouter();
    });

    render(<div />, { wrapper: browserHarness.routerWrapper });

    expect(screen.getByText("Record not found")).toBeVisible();
  });
});
