import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { Command, CommandItem, CommandList } from "./command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
} from "./dropdown-menu";

describe("menu and command touch targets", () => {
  it.each([
    ["phone", 402, 44, 44],
    ["tablet", 700, 28, 44],
    ["desktop", 1440, 28, 32],
  ] as const)("keeps choices at the %s height", async (_label, width, menuHeight, commandHeight) => {
    await page.viewport(width, 900);
    render(
      <>
        <DropdownMenu open>
          <DropdownMenuContent>
            <DropdownMenuItem>Review item</DropdownMenuItem>
            <DropdownMenuSubmenu>
              <DropdownMenuSubmenuTrigger>Saved views</DropdownMenuSubmenuTrigger>
            </DropdownMenuSubmenu>
          </DropdownMenuContent>
        </DropdownMenu>
        <Command>
          <CommandList><CommandItem>Find item</CommandItem></CommandList>
        </Command>
      </>,
    );

    for (const name of ["Review item", "Saved views"]) {
      const item = await screen.findByRole("menuitem", { name });
      await waitFor(() => expect(item.getBoundingClientRect().height).toBeCloseTo(menuHeight, 0));
    }
    const command = await screen.findByRole("option", { name: "Find item" });
    await waitFor(() => expect(command.getBoundingClientRect().height).toBeCloseTo(commandHeight, 0));
  });
});
