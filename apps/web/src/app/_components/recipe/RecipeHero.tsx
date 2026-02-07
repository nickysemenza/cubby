import type { RecipeOut } from "@cubby/schemas/recipe";
import { Clock, ExternalLink, Users } from "lucide-react";
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

  return (
    <div
      className={`relative overflow-hidden rounded-xl ${hasImage ? "h-64 sm:h-80 md:h-96" : "bg-muted py-12"}`}
    >
      {hasImage && (
        <>
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
        </>
      )}

      {/* Content */}
      <div
        className={`relative z-10 flex h-full flex-col justify-end p-6 sm:p-8 ${!hasImage ? "items-start" : ""}`}
      >
        <h2
          className={`font-bold text-3xl tracking-tight sm:text-4xl md:text-5xl ${hasImage ? "text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)]" : ""}`}
        >
          {recipe.name}
        </h2>

        {/* Meta info */}
        <div
          className={`mt-4 flex flex-wrap gap-4 text-sm ${hasImage ? "text-white/90" : "text-muted-foreground"}`}
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
        </div>
      </div>
    </div>
  );
}
