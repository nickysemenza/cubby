import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { ComponentProps } from "react";

import { Button } from "~/ui/primitives/button";

type Props = Omit<
  ComponentProps<typeof Button>,
  "children" | "variant" | "aria-label"
> & {
  "aria-label": string;
  meaning?: "remove" | "delete";
};

export function RemoveButton({
  meaning = "remove",
  size = "icon-sm",
  ...props
}: Props) {
  return (
    <Button type="button" variant="ghost" size={size} {...props}>
      {meaning === "delete" ? <TrashIcon aria-hidden /> : <XIcon aria-hidden />}
    </Button>
  );
}
