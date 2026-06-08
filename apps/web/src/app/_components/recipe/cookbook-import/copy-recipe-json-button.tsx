import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import { Check, ClipboardCopy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";

/**
 * Copy the full extracted `CookbookRecipe` as pretty JSON — the canonical fixture
 * shape `recipe-epub` emits — to drop into a Claude session on the
 * `ingredient-parser` repo. The cookbook analogue of {@link CopyCorpusButton},
 * which does the same for a single parsed ingredient line.
 */
export function CopyRecipeJsonButton({ recipe }: { recipe: CookbookRecipe }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1 text-muted-foreground/60 text-xs hover:text-foreground"
      title="Copy the full extracted recipe as JSON (for an ingredient-parser session)"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(JSON.stringify(recipe, null, 2));
          setCopied(true);
          toast.success("Copied recipe JSON");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy failed");
        }
      }}
    >
      {copied ? (
        <Check className="h-3 w-3" />
      ) : (
        <ClipboardCopy className="h-3 w-3" />
      )}
      copy json
    </Button>
  );
}
