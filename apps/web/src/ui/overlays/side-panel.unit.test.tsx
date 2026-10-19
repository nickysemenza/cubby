import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPTION_GLYPH_NAMES } from "~/ui/common/option-glyph";

import {
  SIDE_PANEL_WIDTH_KEY,
  SIDE_PANEL_WIDTH_VAR,
  SidePanel,
} from "./side-panel";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(SIDE_PANEL_WIDTH_VAR);
  sessionStorage.clear();
});

function renderPanel() {
  const keys = { onPrev: vi.fn(), onNext: vi.fn(), onClose: vi.fn() };
  render(
    <>
      <input aria-label="Search" />
      <SidePanel
        label="Task inspector"
        title="Book cabin"
        code="TSK-TEST"
        {...keys}
      >
        <p>Body</p>
      </SidePanel>
    </>,
  );
  return keys;
}

describe("SidePanel", () => {
  it("steps with J/K and closes with Esc, but not while typing", () => {
    const keys = renderPanel();
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(keys.onNext).toHaveBeenCalledOnce();
    expect(keys.onPrev).toHaveBeenCalledOnce();
    expect(keys.onClose).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search" }), {
      key: "j",
    });
    expect(keys.onNext).toHaveBeenCalledOnce();
  });

  it("keeps identity, close and the key hint in its chrome", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "Task inspector" });
    expect(panel).toHaveTextContent("Book cabin");
    expect(panel).toHaveTextContent("TSK-TEST");
    expect(panel).toHaveTextContent("prev/next");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  });

  it("resizes one session-wide width variable on the document root", () => {
    renderPanel();
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    const width =
      document.documentElement.style.getPropertyValue(SIDE_PANEL_WIDTH_VAR);
    expect(width).toMatch(/^\d+px$/);
    expect(sessionStorage.getItem(SIDE_PANEL_WIDTH_KEY)).toBe(
      width.replace("px", ""),
    );
    fireEvent.doubleClick(handle);
    expect(
      document.documentElement.style.getPropertyValue(SIDE_PANEL_WIDTH_VAR),
    ).toBe("");
  });
});

describe("declared option glyphs", () => {
  it("names only glyphs the web glyph map can draw", () => {
    const declared = Object.values(entityFieldModels).flatMap((model) =>
      model.fields.flatMap((field) =>
        [
          ...(field.control?.options ?? []),
          ...(field.display.valueOptions ?? []),
        ].flatMap((option) => (option.glyph ? [option.glyph.phosphor] : [])),
      ),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !OPTION_GLYPH_NAMES.has(name))).toEqual(
      [],
    );
  });
});
