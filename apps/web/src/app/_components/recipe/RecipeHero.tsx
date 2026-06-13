import type { RecipeOut } from "@cubby/schemas/recipe";
import { Link } from "@tanstack/react-router";
import { BookOpen, Clock, ExternalLink, Users } from "lucide-react";
import { Image } from "~/components/ui/image";

interface RecipeHeroProps {
  recipe: RecipeOut;
}

export function RecipeHero({ recipe }: RecipeHeroProps) {
  const heroImage = recipe.images[0];
  const hasImage = !!heroImage;

  // Count total ingredients across all sections
  const totalIngredients = recipe.sections.reduce(
    (acc, section) => acc + section.ingredients.length,
    0,
  );

  // Count total instruction steps
  const totalSteps = recipe.sections.reduce(
    (acc, section) => acc + section.instructions.length,
    0,
  );

  // Meta row (ingredient/step counts, source) — shared between layouts.
  const metaInfo = (
    <div className="flex flex-wrap items-center gap-4 font-mono text-2xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Users size={12} />
        <span>{totalIngredients} ingredients</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Clock size={12} />
        <span>{totalSteps} steps</span>
      </div>
      {recipe.meta?.url && (
        <a
          href={recipe.meta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:underline"
        >
          <ExternalLink size={12} />
          <span>Source</span>
        </a>
      )}
      {recipe.source?.type === "book" &&
        (recipe.source.cookbookId ? (
          <Link
            to="/cookbooks/$cookbookId"
            params={{ cookbookId: recipe.source.cookbookId }}
            className="flex items-center gap-1.5 hover:underline"
          >
            <BookOpen size={12} />
            <span>{recipe.source.book}</span>
          </Link>
        ) : (
          <span className="flex items-center gap-1.5">
            <BookOpen size={12} />
            <span>{recipe.source.book}</span>
          </span>
        ))}
    </div>
  );

  // No image: the recipe title already shows in the page header, so don't repeat
  // it — render a slim meta band instead of an empty hero block.
  if (!hasImage) {
    return (
      <div className="page-header-accent rounded-xl bg-muted/60 px-6 py-5 ring-1 ring-foreground/10">
        {metaInfo}
      </div>
    );
  }

  // Textbook figure: hairline mat, the photo, and a mono caption. The recipe
  // title lives in the page header, so the photo doesn't repeat it as an
  // overlay — the caption names the figure instead.
  return (
    <figure className="my-0 rounded-lg border border-[var(--border-chunky)] bg-card p-2 shadow-[var(--shadow-chunky)]">
      <Image
        src={heroImage.url}
        alt={recipe.name}
        className="h-64 w-full object-cover sm:h-80 md:h-96"
      />
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 pt-2">
        <span className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
          Fig. 01 — {recipe.name}
        </span>
        {metaInfo}
      </figcaption>
    </figure>
  );
}
