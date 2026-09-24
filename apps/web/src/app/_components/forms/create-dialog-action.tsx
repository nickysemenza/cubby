import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import type { EntityEditDialogRequest } from "~/entities/editing/entity-edit-dialog";

const EntityEditDialog = lazy(() =>
  import("~/entities/editing/entity-edit-dialog").then((module) => ({
    default: module.EntityEditDialog,
  })),
);

const routeSearchValueSchema = z.json();
type RouteSearchValue = z.infer<typeof routeSearchValueSchema> | undefined;
type CreateDialogNavigate = (options: {
  search: (
    previous: Record<string, RouteSearchValue>,
  ) => Record<string, RouteSearchValue>;
  replace?: boolean;
}) => void;

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
  request,
  children = "New",
}: {
  request: EntityEditDialogRequest;
  children?: ReactNode;
}) {
  // Both hooks are route-agnostic on purpose: this button renders on a dozen
  // list routes, and each declares `create` through its generated search
  // schema (`route.create: "dialog"`) rather than through a shared route type. `useNavigate`'s search reducer is
  // typed per-route, so a component that works on all of them can't satisfy it.
  const routeNavigate = useNavigate();
  const navigate = (options: Parameters<CreateDialogNavigate>[0]) => {
    // SAFETY: route-specific search keys are intentionally erased here; every
    // caller's validator accepts the shared optional `create` field.
    routeNavigate(options as never);
  };
  const search = z
    .object({ create: z.boolean().optional() })
    .parse(useSearch({ strict: false }));
  const openedFromUrl = search.create === true;
  // Two sources, deliberately. The button opens through local state so a click
  // is instant and needs nothing from the router — routing the click through a
  // navigation made opening depend on the router being ready, a needless
  // failure mode for a button. The URL is the *other* way in, for the action
  // registry and the empty-state call-to-action, which can only express a
  // destination.
  const [openedByClick, setOpenedByClick] = useState(false);
  const open = openedByClick || openedFromUrl;

  const setOpen = (next: boolean) => {
    setOpenedByClick(next);
    // Only touch the URL to clear a deep link, so clicking the button doesn't
    // rewrite the address bar for a purely local interaction.
    if (!next && openedFromUrl) {
      navigate({
        search: (prev) => ({ ...prev, create: undefined }),
        replace: true,
      });
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        {children}
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <EntityEditDialog open onOpenChange={setOpen} request={request} />
        </Suspense>
      ) : null}
    </>
  );
}
