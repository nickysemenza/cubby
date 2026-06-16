import { createContext, useContext } from "react";

// productId → distinct non-deleted recipe count (via the product's ingredient).
// Populated once at the overview level and read by each product card, so we
// don't fire a query per card. Absent id ⇒ the product has no ingredient link.
export const RecipeUsageContext = createContext<Record<string, number>>({});

export const useRecipeUsage = () => useContext(RecipeUsageContext);
