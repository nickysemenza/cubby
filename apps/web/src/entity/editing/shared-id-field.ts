import type { RefObject } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { z } from "zod";

/**
 * `pendingImageIds`/`removeImageIds` have more than one writer (the image
 * gallery and a presentation's document dropzone ride the same attachment
 * wire shape). Each writer replaces only the slice it previously wrote —
 * tracked in `owned` — so the writers merge instead of clobbering each other.
 */
export function mergeOwnedIds(
  form: UseFormReturn<FieldValues>,
  fieldKey: "pendingImageIds" | "removeImageIds",
  owned: RefObject<readonly string[]>,
  nextOwnIds: readonly string[],
) {
  const current = z.array(z.string()).catch([]).parse(form.getValues(fieldKey));
  const foreign = current.filter((id) => !owned.current.includes(id));
  owned.current = nextOwnIds;
  form.setValue(fieldKey, [...new Set([...foreign, ...nextOwnIds])], {
    shouldDirty: true,
  });
}
