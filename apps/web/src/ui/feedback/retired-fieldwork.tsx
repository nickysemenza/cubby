import { useEffect, useState } from "react";

import { formatRelative } from "~/lib/date-format";
import {
  exportRetiredFieldwork,
  findRetiredFieldwork,
  type RetiredPass,
  removeRetiredFieldwork,
} from "~/lib/retired-fieldwork-storage";
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

const KIND_LABELS = { recount: "Recount", "photo-pass": "Photo pass" } as const;

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // SILENT: blocked storage means there is nothing local to migrate.
    return null;
  }
}

function downloadExport(passes: readonly RetiredPass[]) {
  const blob = new Blob([exportRetiredFieldwork(passes)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "cubby-unfinished-fieldwork.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function describePass(pass: RetiredPass) {
  const parts = [
    `${KIND_LABELS[pass.kind]} · ${pass.scope}`,
    `${pass.settledCount} of ${pass.totalCount} stops done`,
  ];
  if (pass.stagedCount > 0) parts.push(`${pass.stagedCount} unsaved decisions`);
  if (pass.updatedAt) parts.push(formatRelative(pass.updatedAt));
  return parts.join(" · ");
}

/**
 * One-time cleanup of recount/photo-pass state this browser still holds: the
 * flows moved to the native app, so unfinished work is offered for download
 * before the keys are removed.
 */
export function RetiredFieldwork() {
  const [passes, setPasses] = useState<RetiredPass[]>([]);

  useEffect(() => {
    const storage = readStorage();
    if (!storage) return;
    const unfinished = findRetiredFieldwork(storage);
    // Finished or unreadable passes carry nothing to keep; only unfinished
    // work is gated behind the prompt below.
    if (unfinished.length === 0) removeRetiredFieldwork(storage);
    else setPasses(unfinished);
  }, []);

  const discard = () => {
    const storage = readStorage();
    if (storage) removeRetiredFieldwork(storage);
    setPasses([]);
  };

  return (
    <AlertDialog
      open={passes.length > 0}
      onOpenChange={(open) => {
        // "Not now" keeps the data; the prompt returns on the next load.
        if (!open) setPasses([]);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unfinished work in this browser</AlertDialogTitle>
          <AlertDialogDescription>
            Recounts and photo passes now run in the Cubby app, so this browser
            can no longer resume them. Download a copy to keep what was staged,
            or discard it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-1 text-xs">
          {passes.map((pass) => (
            <li key={pass.key}>{describePass(pass)}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogCancel onClick={discard}>Discard</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              downloadExport(passes);
              discard();
            }}
          >
            Download and discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
