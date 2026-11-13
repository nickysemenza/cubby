/**
 * One row of a declared table by column property name. The kernel handles
 * rows of every declared table; each table's own select model is the contract.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- rows of any declared table; the table's InferSelectModel is the contract.
export type ColumnValues = Record<string, unknown>;
