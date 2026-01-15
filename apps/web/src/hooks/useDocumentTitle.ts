import { useEffect } from "react";

/**
 * Updates the document title. Resets to default on unmount.
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
