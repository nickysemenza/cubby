import type { FC } from "react";
import { type Control, useFormState } from "react-hook-form";

import { useNavigationGuard } from "~/ui/hooks/use-navigation-guard";
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

import type { RecipeFormValues } from "./types";

/**
 * Asks before Cancel, a nav click, or a tab close drops unsaved recipe edits.
 * Regression: Cancel and in-app navigation discarded the whole edit silently,
 * and there is no undo to get it back.
 *
 * `released` turns the guard off once a save is under way, so the save's own
 * navigation back to the recipe is not blocked.
 */
export const UnsavedEditsGuard: FC<{
  control: Control<RecipeFormValues>;
  imagesChanged: boolean;
  released: boolean;
}> = ({ control, imagesChanged, released }) => {
  // dirtyFields, not isDirty: see EditorTally.
  const { dirtyFields } = useFormState({ control });
  const dirty =
    !released && (Object.keys(dirtyFields).length > 0 || imagesChanged);
  const guard = useNavigationGuard(dirty);
  return (
    <AlertDialog
      open={guard.held}
      onOpenChange={(open) => {
        if (!open) guard.stay();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
          <AlertDialogDescription>
            Leaving now throws away the changes made to this recipe since it was
            last saved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={guard.stay}>
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={guard.leave}>
            Discard edits
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
