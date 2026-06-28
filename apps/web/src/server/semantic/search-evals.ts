export interface SemanticSearchEval {
  query: string;
  expectedTopName: string;
  entityType: "product" | "location" | "ingredient" | "recipe" | "inventory";
}

export const SEMANTIC_SEARCH_EVALS: SemanticSearchEval[] = [
  {
    query: "plastic tarp",
    expectedTopName: "blue plastic tarp",
    entityType: "product",
  },
  {
    query: "drop cloth",
    expectedTopName: "plastic drop cloth",
    entityType: "product",
  },
  {
    query: "where are tarps",
    expectedTopName: "tarps cloths blankets",
    entityType: "location",
  },
  {
    query: "packout",
    expectedTopName: "packout organizer",
    entityType: "product",
  },
  {
    query: "parchment",
    expectedTopName: "parchment paper",
    entityType: "product",
  },
  {
    query: "tarpaulin",
    expectedTopName: "blue plastic tarp",
    entityType: "product",
  },
  {
    query: "cling film",
    expectedTopName: "plastic wrap",
    entityType: "product",
  },
  {
    query: "adjustable spanner",
    expectedTopName: "adjustable wrench",
    entityType: "product",
  },
  {
    query: "wet dry vac",
    expectedTopName: "shop vacuum",
    entityType: "product",
  },
  {
    query: "painters cover",
    expectedTopName: "painters drop cloth",
    entityType: "product",
  },
];
