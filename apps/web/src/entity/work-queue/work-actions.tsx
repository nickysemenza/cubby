import type { WorkAction, WorkQueueRow } from "@cubby/schemas/work-queue";
import { type ComponentType, Suspense, useState } from "react";
import { toast } from "sonner";

import { featureRegistry } from "~/entity/feature-registry";
import { showErrorToast } from "~/ui/feedback/error-details";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Button } from "~/ui/primitives/button";

/**
 * What a declared action acts on: one row (`item`), or a reason group's
 * whole population (`group`), which the handler re-reads server-side rather
 * than trusting the loaded rows.
 */
export type WorkActionTarget =
  | { readonly scope: "item"; readonly row: WorkQueueRow }
  | {
      readonly scope: "group";
      readonly reason: string;
      readonly count: number;
    };

/**
 * How the client performs a declared action. `run` resolves to the summary
 * toast (null for none); `dialog` opens the owning domain's guided flow.
 */
export type WorkActionHandler =
  | {
      readonly kind: "run";
      readonly run: (target: WorkActionTarget) => Promise<string | null>;
    }
  | {
      readonly kind: "dialog";
      readonly Dialog: ComponentType<{
        target: WorkActionTarget;
        onClose: () => void;
      }>;
    };

/**
 * The client half of every work source's declared actions, keyed by the
 * action's id. Sources declare what a row or group offers; the owning
 * feature fills this table (`features/registry.tsx`) with what performs it.
 */
export type WorkActionTable = Readonly<Record<string, WorkActionHandler>>;

function WorkActionButton({
  action,
  target,
}: {
  action: WorkAction;
  target: WorkActionTarget;
}) {
  const handler = featureRegistry().workActions[action.id];
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  if (!handler) return null;
  const run = async () => {
    if (handler.kind === "dialog") return setOpen(true);
    setRunning(true);
    try {
      const summary = await handler.run(target);
      if (summary) toast.success(summary);
    } catch (error) {
      showErrorToast(error, action.label);
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={action.destructive ? "text-destructive" : undefined}
        disabled={running}
        onClick={(event) => {
          event.stopPropagation();
          if (action.destructive) setConfirming(true);
          else void run();
        }}
      >
        {action.label}
      </Button>
      {action.destructive ? (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{action.label}</AlertDialogTitle>
              <AlertDialogDescription>
                {target.scope === "group"
                  ? `Applies to all ${target.count} rows in this group. There is no undo.`
                  : `Applies to ${target.row.name}. There is no undo.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  void run();
                }}
              >
                {action.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {open && handler.kind === "dialog" ? (
        <Suspense fallback={null}>
          <handler.Dialog target={target} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

/** A row's or group header's declared actions. */
export function WorkActions({
  actions,
  target,
}: {
  actions: readonly WorkAction[];
  target: WorkActionTarget;
}) {
  if (actions.length === 0) return null;
  return (
    <span className="flex items-center justify-end gap-1">
      {actions.map((action) => (
        <WorkActionButton key={action.id} action={action} target={target} />
      ))}
    </span>
  );
}
