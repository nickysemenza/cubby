import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuideDoc } from "./GuideDoc";

afterEach(() => vi.unstubAllGlobals());

describe("GuideDoc", () => {
  it("loads a Markdown asset and keeps links to other docs in the app", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "# Agent guide\n\n[Terminology](../terminology.md)",
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GuideDoc sourcePath="agents/web-ui.md" sourceUrl="/assets/web-ui.md" />,
    );

    expect(
      await screen.findByRole("heading", { name: "Agent guide" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/assets/web-ui.md",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("link", { name: "Terminology" })).toHaveAttribute(
      "href",
      "/docs/terminology",
    );
  });
});
