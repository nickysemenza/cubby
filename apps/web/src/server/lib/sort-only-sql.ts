import type { SQL } from "drizzle-orm";

const sortOnly = new WeakSet<SQL>();

/**
 * Marks an expression that orders and filters rows but is not the field's
 * value. Row reads select the field's own column instead: ranking every
 * Product Category per row read cost a Product detail ~20 ms.
 */
export const sortOnlySql = <T extends SQL>(value: T): T => {
  sortOnly.add(value);
  return value;
};

export const isSortOnlySql = (value: SQL): boolean => sortOnly.has(value);
