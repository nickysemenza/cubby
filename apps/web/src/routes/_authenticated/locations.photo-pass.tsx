import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { retiredPhotoPassTarget } from "~/lib/retired-fieldwork";

// The location photo pass moved to the native app. Kept as a redirect so old
// bookmarks land on the location (or the location list) instead of a 404.
const searchSchema = z.object({
  parent: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/locations/photo-pass")({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ ...retiredPhotoPassTarget(search), replace: true });
  },
});
