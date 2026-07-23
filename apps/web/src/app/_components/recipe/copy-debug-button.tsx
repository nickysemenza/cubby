import { Check, ClipboardCopy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";

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
      className="px-1 text-muted-foreground text-xs hover:text-foreground"
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(getText());
          setCopied(true);
          toast.success(toastLabel);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy failed");
        }
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
