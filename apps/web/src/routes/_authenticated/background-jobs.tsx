import { createFileRoute, redirect } from "@tanstack/react-router";

// The background-job ledger and its history page are gone. The route itself
// stays (linked from old toasts, bookmarks, and `http-route-template.ts`'s
// redirect guard) and just sends visitors to the page that replaced it.
// Unknown search params (`batchId`/`batchIds`) are ignored rather than
// validated, matching `projects.tools.tsx`'s legacy-redirect shape.
export const Route = createFileRoute("/_authenticated/background-jobs")({
  beforeLoad: () => {
    throw redirect({ to: "/problems", replace: true });
  },
});
