import { useEffect } from "react";

/**
 * Updates the document title. Resets to default on unmount.
 *
 * @param title - The title to set, or undefined to use default
 * @param suffix - Optional suffix (defaults to "RecipeHub")
 *
 * @example
 * ```tsx
 * // Sets title to "Pasta Carbonara | RecipeHub"
 * useDocumentTitle(recipe?.name);
 *
 * // Sets title to "Products | RecipeHub"
 * useDocumentTitle("Products");
 * ```
 */
export const useDocumentTitle = (
  title: string | undefined,
  suffix = "RecipeHub",
) => {
  useEffect(() => {
    const previousTitle = document.title;
    if (title) {
      document.title = `${title} | ${suffix}`;
    }
    return () => {
      document.title = previousTitle;
    };
  }, [title, suffix]);
};
