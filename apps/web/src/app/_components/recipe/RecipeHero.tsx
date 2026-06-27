import type { RecipeOut } from "@cubby/schemas/recipe";
import { Clock, ExternalLink, Users } from "lucide-react";
import { Row } from "~/components/layout";
import { Image } from "~/components/ui/image";
import { RecipeSourceLink } from "./recipe-source";

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
    <Row
      align="center"
      wrap
      gap="md"
      className="font-mono text-2xs text-muted-foreground"
    >
      <Row align="center" gap="sm">
        <Users size={12} />
        <span>{totalIngredients} ingredients</span>
      </Row>
      <Row align="center" gap="sm">
        <Clock size={12} />
        <span>{totalSteps} steps</span>
      </Row>
      {recipe.meta?.url && (
        <a
          href={recipe.meta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 hover:underline"
        >
          <ExternalLink size={12} />
          <span>Source</span>
        </a>
      )}
      {recipe.source?.type === "book" && (
        <RecipeSourceLink source={recipe.source} iconSize={12} />
      )}
    </Row>
  );

  // No image: the recipe title already shows in the page header, so don't repeat
  // it — render a slim meta band instead of an empty hero block.
  if (!hasImage) {
    return (
      <div className="page-header-accent rounded-xl bg-muted/60 px-6 py-4 ring-1 ring-foreground/10">
        {metaInfo}
      </div>
    );
  }

  // Textbook figure: hairline mat, the photo, and a mono caption. The recipe
  // title lives in the page header, so the photo doesn't repeat it as an
  // overlay — the caption names the figure instead.
  return (
    <figure className="my-0 rounded-lg border border-[var(--border)] bg-card p-2 shadow-[var(--shadow-chunky)]">
      <Image
        src={heroImage.url}
        alt={recipe.name}
        displayWidth={800}
        className="h-64 w-full object-cover sm:h-80 md:h-96"
      />
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 pt-2">
        <span className="eyebrow">Fig. 01 — {recipe.name}</span>
        {metaInfo}
      </figcaption>
    </figure>
  );
}
