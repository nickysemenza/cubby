import { Button } from "~/ui/primitives/button";

export function CategoryWorkspaceArrangement({
  nested,
  onChange,
}: {
  nested: boolean;
  onChange: (nested: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <fieldset className="flex gap-1">
        <legend className="sr-only">Category arrangement</legend>
        <Button
          size="sm"
          variant={nested ? "secondary" : "ghost"}
          aria-pressed={nested}
          onClick={() => onChange(true)}
        >
          Tree
        </Button>
        <Button
          size="sm"
          variant={nested ? "ghost" : "secondary"}
          aria-pressed={!nested}
          onClick={() => onChange(false)}
        >
          Flat
        </Button>
      </fieldset>
      <span className="text-sm text-muted-foreground">
        Select a row to inspect mappings and spending.
      </span>
    </div>
  );
}
