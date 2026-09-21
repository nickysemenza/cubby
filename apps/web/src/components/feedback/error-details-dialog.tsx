import { useSyncExternalStore } from "react";

import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getAppErrorDetails } from "~/lib/error-utils";

import { ErrorDetailsBody } from "./error-details";
import {
  closeErrorDetailsDialog,
  getErrorDetailsDialogServerSnapshot,
  getErrorDetailsDialogSnapshot,
  subscribeErrorDetailsDialog,
} from "./error-details-store";

/**
 * Single host for the "Technical details" dialog opened from a
 * `showErrorToast` action — mounted once near the root (`__root.tsx`,
 * alongside `<Toaster />`) rather than per-toast, so expanding details never
 * grows the toast itself. Reads the module-level store instead of props: the
 * toast's `onClick` runs outside any component, so there's no prop path from
 * caller to dialog.
 */
export function ErrorDetailsDialogHost() {
  const { open, error } = useSyncExternalStore(
    subscribeErrorDetailsDialog,
    getErrorDetailsDialogSnapshot,
    getErrorDetailsDialogServerSnapshot,
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeErrorDetailsDialog();
      }}
      title="Technical details"
      description={error == null ? "" : getAppErrorDetails(error).message}
      size="md"
    >
      {error != null && <ErrorDetailsBody error={error} />}
    </ResponsiveDialog>
  );
}
