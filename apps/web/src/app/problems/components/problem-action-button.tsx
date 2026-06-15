import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

/**
 * The header "fix all" button shared across Problems sections: a small button
 * that swaps to a spinner + pending label while its mutation runs.
 */
export function ProblemActionButton({
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
          <Spinner className="mr-2" />
          {pendingLabel}
        </>
      ) : (
        idleLabel
      )}
    </Button>
  );
}
