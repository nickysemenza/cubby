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
    <div
      className={`flex flex-wrap items-center gap-4 text-sm ${hasImage ? "text-white/90" : "text-muted-foreground"}`}
    >
      <div className="flex items-center gap-1.5">
        <Users size={16} />
        <span>{totalIngredients} ingredients</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Clock size={16} />
        <span>{totalSteps} steps</span>
      </div>
      {recipe.meta?.url && (
        <a
          href={recipe.meta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:underline"
        >
          <ExternalLink size={16} />
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
            <BookOpen size={16} />
            <span>{recipe.source.book}</span>
          </Link>
        ) : (
          <span className="flex items-center gap-1.5">
            <BookOpen size={16} />
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

  return (
    <div className="relative h-64 overflow-hidden rounded-xl sm:h-80 md:h-96">
      <Image
        src={heroImage.url}
        alt={recipe.name}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: "inset 0 0 120px 40px rgba(0,0,0,0.4)" }}
      />

      {/* Content */}
      <div className="relative z-10 flex h-full flex-col justify-end p-6 sm:p-8">
        <h2 className="font-bold text-3xl text-white tracking-tight drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)] sm:text-4xl md:text-5xl">
          {recipe.name}
        </h2>
        <div className="mt-4">{metaInfo}</div>
      </div>
    </div>
  );
}
