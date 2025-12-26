"use client";

import type { RecipeOut } from "~/schemas/recipe";
import Image from "next/image";
import { Clock, Users, ExternalLink } from "lucide-react";
import Link from "next/link";

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
      {/* Background image with gradient overlay */}
      {hasImage && (
        <>
          <Image
            src={heroImage.url}
            alt={recipe.name}
            fill
            className="object-cover"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
        </>
      )}

      {/* Content */}
      <div
        className={`relative z-10 flex h-full flex-col justify-end p-6 sm:p-8 ${!hasImage ? "items-start" : ""}`}
      >
        <h2
          className={`font-bold text-3xl tracking-tight sm:text-4xl md:text-5xl ${hasImage ? "text-white" : ""}`}
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
            <Link
              href={recipe.meta.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:underline"
            >
              <ExternalLink size={16} />
              <span>Source</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
