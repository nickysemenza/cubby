import type { WorkAction, WorkQueueRow } from "@cubby/schemas/work-queue";
import { Link } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, Suspense, useState } from "react";

import { featureRegistry } from "~/entity/feature-registry";
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

export interface WorkActionProps {
  readonly action: WorkAction;
  readonly target: WorkActionTarget;
}

/**
 * The client half of every work source's declared actions, keyed by the
 * action's id: a component that performs it, built from the triggers below.
 * Sources declare what a row or group offers; the owning feature fills this
 * table (`features/registry.tsx`) lazily.
 */
export type WorkActionTable = Readonly<
  Record<string, ComponentType<WorkActionProps>>
>;

const stop = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

/** A declared action that runs at once; destructive ones confirm first. */
export function WorkActionTrigger({
  action,
  target,
  pending,
  onRun,
}: WorkActionProps & { pending: boolean; onRun: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={action.destructive ? "text-destructive" : undefined}
        disabled={pending}
        onClick={(event) => {
          stop(event);
          if (action.destructive) setConfirming(true);
          else onRun();
        }}
      >
        {action.label}
      </Button>
      {action.destructive ? (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent onClick={stop}>
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
                  onRun();
                }}
              >
                {action.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}

/** A declared guided flow: the button opens the domain's dialog. */
export function WorkActionDialogTrigger({
  action,
  children,
}: {
  action: WorkAction;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={(event) => {
          stop(event);
          setOpen(true);
        }}
      >
        {action.label}
      </Button>
      {open ? children(() => setOpen(false)) : null}
    </>
  );
}

/** A declared action that continues in another page. */
export function WorkActionLink({
  action,
  href,
}: {
  action: WorkAction;
  href: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      nativeButton={false}
      onClick={stop}
      render={<Link to={href} />}
    >
      {action.label}
    </Button>
  );
}

/** A row's or group header's declared actions that have a handler. */
export function WorkActions({
  actions,
  target,
}: {
  actions: readonly WorkAction[];
  target: WorkActionTarget;
}) {
  const handlers = featureRegistry().workActions;
  const performed = actions.flatMap((action) => {
    const Handler = handlers[action.id];
    return Handler ? [{ action, Handler }] : [];
  });
  if (performed.length === 0) return null;
  return (
    <span className="flex items-center justify-end gap-1">
      <Suspense fallback={null}>
        {performed.map(({ action, Handler }) => (
          <Handler key={action.id} action={action} target={target} />
        ))}
      </Suspense>
    </span>
  );
}
