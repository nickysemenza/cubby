import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import type { ComponentProps } from "react";

import { Button } from "~/ui/primitives/button";
import { DropdownMenuTrigger } from "~/ui/primitives/dropdown-menu";

type Props = Omit<ComponentProps<typeof Button>, "children" | "variant">;

export function MoreMenuTrigger({
  "aria-label": label = "More actions",
  size = "icon-sm",
  ...props
}: Props) {
  return (
    <DropdownMenuTrigger
      render={
        <Button
          type="button"
          variant="ghost"
          size={size}
          aria-label={label}
          {...props}
        />
      }
    >
      <DotsThreeIcon aria-hidden />
    </DropdownMenuTrigger>
  );
}
