/**
 * `disabledReason` is the contract that lets a row menu keep an inapplicable
 * verb listed instead of dropping it. These guard the two ways that promise can
 * silently break: the reason not reaching the accessibility tree, and the
 * handler still firing on an item the caller marked unavailable.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
} from "~/components/ui/dropdown-menu";

import { VerbButton, VerbMenuItem } from "./action-verb-ui";

function renderInMenu(item: ReactNode) {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>{item}</DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe("VerbMenuItem", () => {
  it("renders the registry label with no reason by default", async () => {
    const onSelect = vi.fn();
    renderInMenu(<VerbMenuItem verb="markPurchased" onSelect={onSelect} />);

    const item = await screen.findByRole("menuitem");
    expect(item).toHaveTextContent("Mark purchased");
    expect(item).not.toHaveAttribute("aria-disabled", "true");

    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("shows the reason as visible text, not a tooltip", async () => {
    renderInMenu(
      <VerbMenuItem verb="markPurchased" disabledReason="Already purchased" />,
    );

    // Asserted as text ON the menu item, not merely present in the document:
    // that is the whole distinction from a tooltip, which a disabled item can
    // never open (`data-disabled:pointer-events-none`).
    const item = await screen.findByRole("menuitem");
    expect(item).toHaveTextContent("Mark purchased");
    expect(item).toHaveTextContent("Already purchased");
  });

  it("folds the reason into the accessible name", async () => {
    renderInMenu(
      <VerbMenuItem
        verb="moveToProject"
        disabledReason="Already in this project"
      />,
    );

    expect(
      await screen.findByRole("menuitem", {
        name: "Move to project..., Already in this project",
      }),
    ).toBeInTheDocument();
  });

  it("treats a reason as disabling, and does not fire the handler", async () => {
    const onSelect = vi.fn();
    renderInMenu(
      <VerbMenuItem
        verb="markPurchased"
        disabledReason="Adjustments aren't classified"
        onSelect={onSelect}
      />,
    );

    const item = await screen.findByRole("menuitem");
    expect(item).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("drops `render` when disabled, so no anchor stays keyboard-reachable", async () => {
    renderInMenu(
      <VerbMenuItem
        verb="printLabel"
        disabledReason="No label for this row"
        render={<a href="/labels">Print label</a>}
      />,
    );

    await screen.findByRole("menuitem");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("VerbButton", () => {
  it("makes an unavailable inspector action legible and inert", () => {
    const onClick = vi.fn();
    render(
      <VerbButton
        verb="duplicate"
        disabledReason="No compatible copy target"
        onClick={onClick}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Duplicate, No compatible copy target",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "No compatible copy target");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
