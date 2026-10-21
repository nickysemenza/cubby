export const BROWSER_OPERATION_PATH = "/api/operations";

/** Names only: operation inputs never belong in URLs or trace route names. */
export const browserOperationPath = (
  operation: string | readonly string[],
): string =>
  `${BROWSER_OPERATION_PATH}/${typeof operation === "string" ? encodeURIComponent(operation) : `batch~${operation.map(encodeURIComponent).join(",")}`}`;

export const isBrowserOperationPath = (pathname: string): boolean =>
  pathname.startsWith(`${BROWSER_OPERATION_PATH}/`);
