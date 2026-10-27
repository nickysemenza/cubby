import type { ReactNode } from "react";

import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

/**
 * The run button shared by maintenance tools: a small button
 * that swaps to a spinner + pending label while its mutation runs.
 */
export function PendingButton({
  onClick,
  isPending,
  idleLabel,
  pendingLabel,
}: {
  onClick: () => void;
  isPending: boolean;
  idleLabel: ReactNode;
  pendingLabel: string;
}) {
  return (
    <Button size="sm" onClick={onClick} disabled={isPending}>
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
