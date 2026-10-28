import type { WorkAction, WorkSourceActionId } from "@cubby/schemas/work-queue";
import { Link } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, Suspense, useState } from "react";

import { featureRegistry } from "~/entity/feature-registry";
import {
  problemActionHandler,
  type ProblemActionHandlers,
} from "~/entity/problems/problem-actions";
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

import type { WorkActionProps, WorkActionTarget } from "./work-action-props";

export type { WorkActionProps, WorkActionTarget } from "./work-action-props";

/**
 * The client half of every work source's declared actions: a component that
 * performs it, built from the triggers below. Problem handlers are shaped by
 * their declarations (`ProblemActionHandlers`); other sources' actions by
 * `WorkSourceActionId`. The owning feature fills both lazily
 * (`features/registry.tsx`).
 */
export type WorkActionTable = {
  readonly problems: ProblemActionHandlers;
  readonly sources: Readonly<
    Record<WorkSourceActionId, ComponentType<WorkActionProps>>
  >;
};

const workActionHandler = (
  table: WorkActionTable,
  id: string,
): ComponentType<WorkActionProps> | undefined =>
  Object.entries(table.sources).find(([candidate]) => candidate === id)?.[1] ??
  problemActionHandler(table.problems, id);

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
  const table = featureRegistry().workActions;
  const performed = actions.flatMap((action) => {
    const Handler = workActionHandler(table, action.id);
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
