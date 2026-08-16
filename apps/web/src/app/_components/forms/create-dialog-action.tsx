import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { z } from "zod";
import { Button } from "~/components/ui/button";

type CreateDialog = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

/**
 * The `?create=true` search param this component reads.
 *
 * A list route whose `validateSearch` is a strict `z.object` must merge this
 * fragment, or the router strips the key the moment the dialog writes it. Same
 * contract as `tableSearchFields`.
 */
export const createDialogSearchField = {
  create: z.boolean().optional().catch(undefined),
};

/**
 * Shared list-toolbar trigger for entities created in a dialog.
 *
 * Open state lives in the URL, not component state, which is what makes a
 * dialog-created entity addressable at all. Entities like meal, task and vendor
 * have no `/new` route by design, so before this the *only* way to reach their
 * create form was clicking this button — the action registry and the list empty
 * states can express a destination but not a click, so their call-to-action
 * silently rendered nothing. `createActionFor` now points at `?create=true`.
 *
 * Cleared with `replace` on close so a refresh or back-nav can't reopen it.
 */
export function CreateDialogAction({
  Dialog,
  children = "New",
}: {
  Dialog: CreateDialog;
  children?: ReactNode;
}) {
  // Both hooks are route-agnostic on purpose: this button renders on a dozen
  // list routes, and each declares `create` via `createDialogSearchField`
  // rather than through a shared route type. `useNavigate`'s search reducer is
  // typed per-route, so a component that works on all of them can't satisfy it
  // — the cast is that boundary, not a shortcut around a real type error.
  const navigate = useNavigate() as unknown as (opts: {
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
    replace?: boolean;
  }) => void;
  const search = useSearch({ strict: false }) as { create?: boolean };
  const open = search.create === true;

  const setOpen = (next: boolean) => {
    navigate({
      search: (prev) => ({ ...prev, create: next ? true : undefined }),
      replace: true,
    });
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        {children}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} />
    </>
  );
}
