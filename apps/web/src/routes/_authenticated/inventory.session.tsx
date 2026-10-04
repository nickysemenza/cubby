import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { retiredRecountTarget } from "~/lib/retired-fieldwork";

// Recount and sweep moved to the native app. Kept as a redirect so old
// bookmarks and printed links land on the location (or the inventory list)
// instead of a 404.
const searchSchema = z.object({
  parent: z.string().optional().catch(undefined),
  worklist: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/inventory/session")({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ ...retiredRecountTarget(search), replace: true });
  },
});
