import {
  type CookbookRecipe,
  cookbookRecipesSchema,
} from "@cubby/schemas/cookbook";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Check, Import, Upload } from "lucide-react";
import { useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { dedupe } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";
import { IngredientPreviewTable } from "../recipe-form/ingredient-preview-table";
import { formatRichText } from "../richtext";

type ImportResult =
  | { status: "importing" }
  | { status: "done"; id: string }
  | { status: "error"; message: string };

// food-cli passes the .epub file path as `source`; turn it into a clean,
// editable book label that stays stable across re-imports.
const deriveBookName = (source: string | undefined): string => {
  if (!source) return "";
  const base = source.split(/[/\\]/).pop() ?? source;
  return base.replace(/\.epub$/i, "");
};

/**
 * Import recipes extracted from an EPUB cookbook. The user runs
 * `food-cli scrape-epub book.epub --json` locally, uploads the resulting JSON
 * here, reviews the parsed recipes, and imports a selected subset. Each goes
 * through `recipe.insertCookbook`, which upserts by (book, title).
 */
export function CookbookImport() {
  const api = useTRPC();
  const insertCookbook = useMutation(
    api.recipe.insertCookbook.mutationOptions(),
  );
  const fileId = useId();
  const bookId = useId();
  const pasteId = useId();

  const [recipes, setRecipes] = useState<CookbookRecipe[] | null>(null);
  const [book, setBook] = useState("");
  const [pasted, setPasted] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<Map<number, ImportResult>>(new Map());
  const [importing, setImporting] = useState(false);
  // Rendering hundreds of parsed-ingredient tables is heavy; mark it a
  // transition so the click stays responsive and the preview streams in instead
  // of freezing the tab.
  const [isLoading, startLoading] = useTransition();

  // Titles already imported from this book — so we can flag re-imports as updates.
  const trimmedBook = book.trim();
  const { data: existingTitles } = useQuery(
    api.recipe.getCookbookTitles.queryOptions(
      { book: trimmedBook },
      { enabled: recipes != null && trimmedBook.length > 0 },
    ),
  );
  const existingTitleSet = useMemo(
    () => new Set((existingTitles ?? []).map((t) => t.trim())),
    [existingTitles],
  );

  // A cross-recipe reference only links if its target recipe will exist after
  // import: either it's a selected recipe in this batch, or already in the book.
  const linkableTitles = useMemo(() => {
    const titles = new Set<string>();
    for (const t of existingTitleSet) titles.add(t.trim().toLowerCase());
    if (recipes) {
      for (const i of selected) {
        titles.add(recipes[i].meta.title.trim().toLowerCase());
      }
    }
    return titles;
  }, [recipes, selected, existingTitleSet]);

  // Parse + validate cookbook JSON from either an uploaded file or pasted text
  // (e.g. `food-cli scrape-epub book.epub --json | pbcopy`).
  const loadFromText = (text: string) => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      toast.error("Could not parse JSON");
      return;
    }
    const parsed = cookbookRecipesSchema.safeParse(data);
    if (!parsed.success) {
      toast.error("Not a valid cookbook export (food-cli --json)");
      return;
    }
    if (parsed.data.length === 0) {
      toast.error("No recipes found");
      return;
    }
    const loaded = parsed.data;
    startLoading(() => {
      setRecipes(loaded);
      setBook(deriveBookName(loaded[0]?.source));
      setSelected(new Set(loaded.map((_, i) => i)));
      setResults(new Map());
    });
  };

  const handleFile = async (file: File) => loadFromText(await file.text());

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
      } else {
        next.add(i);
      }
      return next;
    });
  };

  const allSelected = recipes != null && selected.size === recipes.length;
  const toggleAll = () => {
    if (!recipes) return;
    setSelected(allSelected ? new Set() : new Set(recipes.map((_, i) => i)));
  };

  const runImport = async () => {
    if (!recipes || !book.trim()) return;
    setImporting(true);
    const bookName = book.trim();
    const indices = [...selected].sort((a, b) => a - b);

    // Pass 1: create/update every selected recipe. Cross-recipe references only
    // resolve to recipes that already exist, so on a fresh book this pass is
    // effectively flat. Sequential to keep ingredient find-or-create races minimal.
    const succeeded = new Set<number>();
    for (const i of indices) {
      setResults((prev) => new Map(prev).set(i, { status: "importing" }));
      try {
        const { id } = await insertCookbook.mutateAsync({
          recipe: recipes[i],
          book: bookName,
        });
        setResults((prev) => new Map(prev).set(i, { status: "done", id }));
        succeeded.add(i);
      } catch (error) {
        setResults((prev) =>
          new Map(prev).set(i, {
            status: "error",
            message: getErrorMessage(error),
          }),
        );
      }
    }

    // Pass 2: every selected recipe now has an id, so re-import the ones with
    // references — their lines now link to the existing book recipes. Best-effort
    // (keep the pass-1 result on failure).
    for (const i of indices) {
      if (!succeeded.has(i) || recipes[i].references.length === 0) continue;
      try {
        await insertCookbook.mutateAsync({
          recipe: recipes[i],
          book: bookName,
        });
      } catch {
        // ignore — the recipe is already imported; only the links failed
      }
    }

    setImporting(false);
    toast.success("Cookbook import finished");
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-semibold text-xl">Import cookbook</h1>
        <p className="text-muted-foreground text-sm">
          Upload the JSON from{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            food-cli scrape-epub book.epub --json
          </code>
          , review, and import the recipes you want.
        </p>
      </div>

      <div className="space-y-3 rounded border border-border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={fileId}>Cookbook JSON file</Label>
            <Input
              id={fileId}
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </div>
          {recipes != null && (
            <div className="space-y-1.5">
              <Label htmlFor={bookId}>Book name</Label>
              <Input
                id={bookId}
                value={book}
                onChange={(e) => setBook(e.target.value)}
                placeholder="e.g. Salt Fat Acid Heat"
              />
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={pasteId}>…or paste JSON</Label>
          <Textarea
            id={pasteId}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="food-cli scrape-epub book.epub --json | pbcopy, then paste here"
            // Clamp height: field-sizing-content would otherwise grow to fit the
            // whole pasted blob — we don't need to see it.
            className="max-h-16 resize-none font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!pasted.trim() || isLoading}
            onClick={() => loadFromText(pasted)}
          >
            {isLoading && <Spinner className="mr-1" />}
            Load pasted JSON
          </Button>
        </div>
      </div>

      {recipes != null && (
        <>
          <div className="flex items-center justify-between gap-3 border-border border-y py-2">
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label="Select all recipes"
                checked={allSelected}
                onCheckedChange={toggleAll}
              />
              {selected.size} of {recipes.length} selected
            </div>
            <Button
              type="button"
              size="sm"
              onClick={runImport}
              disabled={importing || selected.size === 0 || !book.trim()}
            >
              {importing ? (
                <Spinner className="mr-1" />
              ) : (
                <Import className="mr-1 h-4 w-4" />
              )}
              Import {selected.size} selected
            </Button>
          </div>

          <div className="space-y-3">
            {recipes.map((recipe, i) => (
              <RecipeCard
                // biome-ignore lint/suspicious/noArrayIndexKey: recipes are a fixed ordered list from one upload
                key={i}
                recipe={recipe}
                selected={selected.has(i)}
                onToggle={() => toggle(i)}
                result={results.get(i)}
                alreadyImported={existingTitleSet.has(recipe.meta.title.trim())}
                linkableTitles={linkableTitles}
              />
            ))}
          </div>
        </>
      )}

      {recipes == null && (
        <div className="flex flex-col items-center gap-2 rounded border border-border border-dashed p-8 text-muted-foreground">
          <Upload className="h-6 w-6" />
          <p className="text-sm">Choose a cookbook JSON file to begin.</p>
        </div>
      )}
    </div>
  );
}

function RecipeCard({
  recipe,
  selected,
  onToggle,
  result,
  alreadyImported,
  linkableTitles,
}: {
  recipe: CookbookRecipe;
  selected: boolean;
  onToggle: () => void;
  result: ImportResult | undefined;
  alreadyImported: boolean;
  linkableTitles: Set<string>;
}) {
  // Ingredient names across the whole recipe, so instructions in one section can
  // highlight ingredients defined in another (matches the recipe-form preview).
  const namesForHighlighting = useMemo(
    () =>
      dedupe(
        recipe.sections
          .flatMap((s) => s.ingredients)
          .map((line) => wasm.parse_ingredient(line).name)
          .filter((n) => n.length > 0),
      ),
    [recipe],
  );

  // Parse instructions to rich text once per section (not on every render).
  const richBySection = useMemo(
    () =>
      recipe.sections.map((section) =>
        section.instructions.map((line) => {
          try {
            return formatRichText(
              wasm.parse_rich_text(line, namesForHighlighting),
            );
          } catch {
            return [line] as ReturnType<typeof formatRichText>;
          }
        }),
      ),
    [recipe, namesForHighlighting],
  );

  return (
    <Card size="sm">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Checkbox checked={selected} onCheckedChange={onToggle} />
        <div className="flex flex-1 items-baseline gap-2">
          <CardTitle>{recipe.meta.title}</CardTitle>
          {recipe.meta.recipe_yield && (
            <span className="text-muted-foreground text-xs">
              {recipe.meta.recipe_yield}
            </span>
          )}
          {alreadyImported && (
            <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 text-xs dark:bg-amber-950 dark:text-amber-400">
              already imported · will update
            </span>
          )}
        </div>
        <ImportStatus result={result} />
      </CardHeader>
      <CardContent>
        {recipe.references.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
            <span className="text-muted-foreground">Uses:</span>
            {recipe.references.map((ref) => {
              const linkable = linkableTitles.has(
                ref.title.trim().toLowerCase(),
              );
              return (
                <span
                  key={ref.title}
                  title={
                    linkable
                      ? `Will link (${ref.confidence})`
                      : "Target recipe not in this import — stays an ingredient"
                  }
                  className={cn(
                    "rounded-sm px-1.5 py-0.5 font-medium",
                    linkable
                      ? "bg-accent/20 text-accent-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  → {ref.title}
                  {!linkable && " (not imported)"}
                </span>
              );
            })}
          </div>
        )}
        <div className="grid gap-x-4 gap-y-2 md:grid-cols-2">
          {/* Ingredients */}
          <div className="space-y-2">
            {recipe.sections.map((section, si) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: sections are a fixed ordered list
              <div key={si} className="space-y-0.5">
                {section.name && (
                  <div className="font-medium text-muted-foreground text-xs">
                    {section.name}
                  </div>
                )}
                <IngredientPreviewTable ingredientLines={section.ingredients} />
              </div>
            ))}
          </div>

          {/* Instructions */}
          <div className="space-y-2">
            {recipe.sections.map((section, si) =>
              section.instructions.length > 0 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: sections are a fixed ordered list
                <div key={si} className="space-y-0.5">
                  {section.name && (
                    <div className="font-medium text-muted-foreground text-xs">
                      {section.name}
                    </div>
                  )}
                  <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground text-xs leading-snug">
                    {richBySection[si]?.map((rich, ii) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: instructions are ordered by line
                      <li key={ii}>{rich}</li>
                    ))}
                  </ol>
                </div>
              ) : null,
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ImportStatus({ result }: { result: ImportResult | undefined }) {
  if (!result) return null;
  if (result.status === "importing") return <Spinner />;
  if (result.status === "done") {
    return (
      <Link
        to="/recipes/$id"
        params={{ id: result.id }}
        className="flex items-center gap-1 text-green-600 text-sm"
      >
        <Check className="h-4 w-4" /> Imported
      </Link>
    );
  }
  return (
    <span className="flex items-center gap-1 text-destructive text-sm">
      <AlertCircle className="h-4 w-4" /> {result.message}
    </span>
  );
}
