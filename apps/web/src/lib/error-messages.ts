/**
 * Centralized error message templates for consistent error handling.
 * Using template functions ensures consistency and prevents typos.
 */

// Entity not found errors
export const notFoundError = (entity: string, id: string | number) =>
  `${entity} ${id} not found`;

export const notFoundByNameError = (entity: string, name: string) =>
  `${entity} with name "${name}" not found`;

export const ambiguousNameError = (entity: string, name: string) =>
  `Multiple ${entity}s found with name "${name}", please use ID`;

// Database operation errors
export const FAILED_TO_INSERT = "Failed to insert record";
export const FAILED_TO_UPDATE = "Failed to update record";

export const failedToCreate = (entity: string) => `Failed to create ${entity}`;
export const failedToRetrieve = (entity: string) =>
  `Failed to retrieve created ${entity}`;
export const failedToFetch = (
  entity: string,
  operation: "created" | "updated",
) => `Failed to fetch ${operation} ${entity}`;
