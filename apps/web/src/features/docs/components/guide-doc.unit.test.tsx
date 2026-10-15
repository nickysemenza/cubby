import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuideDoc } from "./guide-doc";

afterEach(() => vi.unstubAllGlobals());

describe("GuideDoc", () => {
  it("loads a Markdown asset and keeps links to other docs in the app", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "# Burn-down\n\n[Terminology](terminology.md)",
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GuideDoc sourcePath="burn-down.md" sourceUrl="/assets/burn-down.md" />,
    );

    expect(
      await screen.findByRole("heading", { name: "Burn-down" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/assets/burn-down.md",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("link", { name: "Terminology" })).toHaveAttribute(
      "href",
      "/docs/terminology",
    );
  });
});
