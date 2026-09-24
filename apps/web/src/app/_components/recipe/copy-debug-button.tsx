import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { ClipboardIcon as ClipboardCopy } from "@phosphor-icons/react/dist/csr/Clipboard";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";

/**
 * Shared shell for the "copy as debug" buttons that drop facts into a Claude
 * session on the `ingredient-parser` repo. Owns the copied-state, toast, and
 * icon-swap; callers supply the payload via `getText` (a thunk, so it's only
 * built on click). See {@link CopyJsonButton} for the JSON convenience wrapper,
 * and `CopyCorpusButton` / `CopyRecipeParseButton` for the text-report ones.
 */
export function CopyDebugButton({
  getText,
  label,
  toastLabel,
  title,
}: {
  getText: () => string;
  /** Button text; omit for an icon-only button. */
  label?: string;
  toastLabel: string;
  title: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="px-1 text-xs text-muted-foreground hover:text-foreground"
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        if (!(await copyText(getText()))) {
          toast.error("Copy failed");
          return;
        }
        setCopied(true);
        toast.success(toastLabel);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check className="size-3" />
      ) : (
        <ClipboardCopy className="size-3" />
      )}
      {label}
    </Button>
  );
}

/** Copy any value as pretty JSON — e.g. the `ImportRecipe` extraction fixture. */
export function CopyJsonButton({
  value,
  title,
  label = "copy json",
  toastLabel = "Copied JSON",
}: {
  value: unknown;
  title: string;
  label?: string;
  toastLabel?: string;
}) {
  return (
    <CopyDebugButton
      getText={() => JSON.stringify(value, null, 2)}
      label={label}
      toastLabel={toastLabel}
      title={title}
    />
  );
}
