import { createFileRoute, redirect } from "@tanstack/react-router";

import { retiredScanTarget } from "~/lib/retired-fieldwork";

// Barcode and QR scanning moved to the native app. Kept as a redirect so old
// bookmarks and links land on Today instead of a 404.
export const Route = createFileRoute("/_authenticated/scan")({
  beforeLoad: () => {
    throw redirect({ ...retiredScanTarget(), replace: true });
  },
});
