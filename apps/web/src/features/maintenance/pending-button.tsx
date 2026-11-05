import type { ReactNode } from "react";

import { Button } from "~/ui/shadcn/button";
import { Spinner } from "~/ui/shadcn/spinner";

/**
 * The run button shared by maintenance tools: a small button
 * that swaps to a spinner + pending label while its mutation runs.
 */
export function PendingButton({
  onClick,
  disabled = false,
  isPending,
  idleLabel,
  pendingLabel,
}: {
  onClick: () => void;
  disabled?: boolean;
  isPending: boolean;
  idleLabel: ReactNode;
  pendingLabel: string;
}) {
  return (
    <Button size="sm" onClick={onClick} disabled={disabled || isPending}>
      {isPending ? (
        <>
          <Spinner className="mr-2" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        idleLabel
      )}
    </Button>
  );
}
