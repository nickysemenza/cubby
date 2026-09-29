import type { CookbookSummary } from "@cubby/schemas/recipe";
import { useState } from "react";

import { ChipsInput } from "~/app/_components/forms/chips-input";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { cookbook as cookbookOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getErrorMessage } from "~/lib/error-utils";

/**
 * A cookbook is born from an import, so its Edit action is title, authors and
 * subjects only, through the cookbook operation rather than the generic
 * create/update dialog.
 */
export function CookbookEditDialog({
  record,
  onClose,
}: {
  record: CookbookSummary;
  onClose: () => void;
}) {
  const [name, setName] = useState(record.book);
  const [author, setAuthor] = useState(record.author);
  const [subjects, setSubjects] = useState(record.subjects);
  const update = useActionMutation({
    mutationFn: () => cookbookOperations.update.mutationOptions(),
    successToastId: "entity-updated:cookbook",
    success: "Cookbook updated",
    error: (error) => getErrorMessage(error) || "Failed to update cookbook",
  });
  const save = () => {
    const title = name.trim();
    if (!title) return;
    update
      .mutateAsync({ id: record.id, data: { name: title, author, subjects } })
      .then(onClose, () => undefined); // The mutation toasts the failure.
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit cookbook"
      footer={
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={update.isPending || !name.trim()}
          >
            Save changes
          </Button>
        </DialogFooter>
      }
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="cookbook-title">Title</Label>
          <Input
            id="cookbook-title"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cookbook-authors">Authors</Label>
          <ChipsInput
            id="cookbook-authors"
            value={author}
            onChange={setAuthor}
            placeholder="Add author"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cookbook-subjects">Subjects</Label>
          <ChipsInput
            id="cookbook-subjects"
            value={subjects}
            onChange={setSubjects}
            placeholder="Add subject"
          />
        </div>
      </div>
    </ResponsiveDialog>
  );
}
