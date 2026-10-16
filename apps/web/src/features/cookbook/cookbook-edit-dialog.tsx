import type { CookbookSummary } from "@cubby/schemas/recipe";
import { getErrorMessage } from "@cubby/shared";
import { useState } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { cookbook as cookbookOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ChipsInput } from "~/ui/forms/chips-input";
import { Overlay } from "~/ui/overlays/overlay";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";

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
  const [name, setName] = useState(record.name);
  const [author, setAuthor] = useState(record.author);
  const [subjects, setSubjects] = useState(record.subjects);
  const update = useActionMutation({
    mutationFn: () => cookbookOperations.update.mutationOptions(),
    successToastId: "entity-updated:cookbook",
    success: "Cookbook updated",
    error: (error) => getErrorMessage(error) || "Failed to update cookbook",
  });
  const save = async () => {
    const title = name.trim();
    if (!title) return;
    await update.mutateAsync({
      id: record.id,
      data: { name: title, author, subjects },
    });
    onClose();
  };
  return (
    <Overlay
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit cookbook"
      onCancel={onClose}
      primary={{
        label: "Save changes",
        pending: update.isPending,
        disabled: !name.trim(),
        onClick: save,
      }}
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
    </Overlay>
  );
}
