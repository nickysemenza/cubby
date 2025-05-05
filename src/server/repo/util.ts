import { Prisma } from "@prisma/client";
import { type SortParams } from "~/schemas/util";

// Helper function to format search terms for PostgreSQL full-text search
export const formatSearchTerm = (
  term?: string,
): Prisma.StringFilter | undefined => {
  if (term === undefined || term.trim() === "") {
    return undefined;
  }
  return { contains: term, mode: "insensitive" };
  // Replace spaces with & operator for AND logic
  // however, this seems slower than just using contains
  // return { search: term.trim().split(/\s+/).join(" & ") };
};

// Helper function to get sort direction for a field
export const getSortDirection = (sort: SortParams, field: string) =>
  sort.orderBy === field ? sort.direction : undefined;
