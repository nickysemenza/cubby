export const AppErrorReason = {
  NO_ORGANIZATION_SELECTED: "NO_ORGANIZATION_SELECTED",
  PRODUCT_ALREADY_EXISTS: "PRODUCT_ALREADY_EXISTS",
} as const;

export type AppErrorReason =
  (typeof AppErrorReason)[keyof typeof AppErrorReason];
