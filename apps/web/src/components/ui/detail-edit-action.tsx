import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import type { ComponentProps } from "react";
import { Button } from "~/components/ui/button";

export function DetailEditAction(props: ComponentProps<typeof Button>) {
  return (
    <Button variant="outline" size="sm" {...props}>
      <PencilIcon /> Edit
    </Button>
  );
}
