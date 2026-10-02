import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuContent,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

describe("DropdownMenu submenu", () => {
  it("opens from the keyboard, selects a saved view, and returns focus to the trigger", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSubmenu>
            <DropdownMenuSubmenuTrigger>Saved views</DropdownMenuSubmenuTrigger>
            <DropdownMenuSubmenuContent>
              <DropdownMenuItem onClick={onSelect}>Current view</DropdownMenuItem>
            </DropdownMenuSubmenuContent>
          </DropdownMenuSubmenu>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const submenuTrigger = await screen.findByRole("menuitem", {
      name: "Saved views",
    });
    fireEvent.keyDown(submenuTrigger, { key: "ArrowRight" });

    const submenu = await screen.findByRole("menu", {
      name: "Saved views",
    });
    const view = within(submenu).getByRole("menuitem", {
      name: "Current view",
    });
    fireEvent.click(view);

    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
