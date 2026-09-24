import type { RecipeOut } from "@cubby/schemas/recipe";
import { ArrowSquareOutIcon as ExternalLink } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookBookmarkIcon as BookMarked } from "@phosphor-icons/react/dist/csr/BookBookmark";
import { ClockIcon as Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { GitForkIcon as GitFork } from "@phosphor-icons/react/dist/csr/GitFork";
import { TimerIcon as Timer } from "@phosphor-icons/react/dist/csr/Timer";
import { UsersIcon as Users } from "@phosphor-icons/react/dist/csr/Users";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { Link } from "@tanstack/react-router";
import { sumBy } from "es-toolkit";

import { Row } from "~/components/layout";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { Image } from "~/components/ui/image";

import { RecipeSourceLink } from "./recipe-source";
import { recipeTimeEntries } from "./recipe-utils";

/**
 * The recipe's own source badge(s): where it came from (book/website/notion/
 * other, via `RecipeSourceLink` + a "show all…" filter link) and, separately,
 * the lineage pointer to the recipe it was forked from. Split out of
 * `RecipeHero` to keep that component's branching under the lint complexity
 * ceiling.
 */
function RecipeSourceBadges({ recipe }: { recipe: RecipeOut }) {
  return (
    <>
      {recipe.source?.type === "book" && (
        <Row align="center" gap="tight">
          <RecipeSourceLink source={recipe.source} iconSize={12} />
          <EntityFilterLink
            to="/recipes"
            search={
              recipe.source.cookbookId
                ? { source: recipe.source.cookbookId }
                : { sourceType: "Book" }
            }
            label={
              recipe.source.cookbookId
                ? `Show all recipes from ${recipe.source.book}`
                : "Show all recipes from books"
            }
          />
        </Row>
      )}
      {recipe.source?.type === "website" && (
        <EntityFilterLink
          to="/recipes"
          search={{ sourceType: "Website" }}
          label="Show all recipes from websites"
        />
      )}
      {recipe.source?.type === "notion" && (
        <EntityFilterLink
          to="/recipes"
          search={{ sourceType: "Notion" }}
          label="Show all recipes from Notion"
        />
      )}
      {recipe.source?.type === "other" && (
        <EntityFilterLink
          to="/recipes"
          search={{ sourceType: "Other" }}
          label="Show all recipes from other sources"
        />
      )}
      {recipe.forkedFromRecipeId && (
        <Row align="center" gap="sm">
          <GitFork size={12} />
          <span>Forked from</span>
          <Link
            to="/recipes/$shortcode"
            params={{ shortcode: recipe.forkedFromRecipeId }}
            className="hover:underline"
          >
            {recipe.forkedFromRecipeName ?? recipe.forkedFromRecipeId}
          </Link>
        </Row>
      )}
    </>
  );
}

interface RecipeHeroProps {
  recipe: RecipeOut;
}

export function RecipeHero({ recipe }: RecipeHeroProps) {
  const heroImage = recipe.images[0];
  const hasImage = !!heroImage;

  // Count total ingredients across all sections
  const totalIngredients = sumBy(
    recipe.sections,
    (section) => section.ingredients.length,
  );

  // Count total instruction steps
  const totalSteps = sumBy(
    recipe.sections,
    (section) => section.instructions.length,
  );

  // Printed times, equipment, and page — whatever the source actually carried.
  // Each is independently optional: a web recipe has times and no page, a
  // cookbook recipe often has a page and prose times with no minute counts.
  const times = recipeTimeEntries(recipe.meta?.times);
  const equipment = recipe.meta?.equipment ?? [];
  const page = recipe.meta?.page;

  // Meta row (ingredient/step counts, times, source) — shared between layouts.
  const metaInfo = (
    <Row
      align="center"
      wrap
      gap="sm"
      className="font-mono text-2xs text-muted-foreground md:gap-4"
    >
      <Row align="center" gap="sm">
        <Users size={12} />
        <span>{totalIngredients} ingredients</span>
      </Row>
      <Row align="center" gap="sm">
        <Clock size={12} />
        <span>{totalSteps} steps</span>
      </Row>
      {times.map((t) => (
        <Row key={t.label} align="center" gap="sm">
          <Timer size={12} />
          <span>
            {t.label} {t.value}
          </span>
        </Row>
      ))}
      {equipment.length > 0 && (
        <Row align="center" gap="sm">
          <Wrench size={12} />
          <span>{equipment.join(", ")}</span>
        </Row>
      )}
      {page && (
        <Row align="center" gap="sm">
          <BookMarked size={12} />
          <span>p. {page}</span>
        </Row>
      )}
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
      <RecipeSourceBadges recipe={recipe} />
    </Row>
  );

  // No image: the recipe title already shows in the page header, so don't repeat
  // it — render a slim meta band instead of an empty hero block.
  if (!hasImage) {
    return (
      <div className="page-header-accent border border-[var(--border)] bg-muted/60 px-3 py-3 sm:px-6 sm:py-4">
        {metaInfo}
      </div>
    );
  }

  // Textbook figure: hairline mat, the photo, and a mono caption. The recipe
  // title lives in the page header, so the photo doesn't repeat it as an
  // overlay — the caption names the figure instead.
  return (
    <figure className="my-0 border border-[var(--border)] bg-card p-2">
      <Image
        src={heroImage.url}
        alt={recipe.name}
        displayWidth={800}
        className="h-52 w-full object-cover sm:h-80 md:h-96"
      />
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 pt-2">
        <span className="eyebrow">Fig. 01 — {recipe.name}</span>
        {metaInfo}
      </figcaption>
    </figure>
  );
}
