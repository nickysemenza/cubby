/**
 * Flattens a nested array type by extracting the inner type.
 * @template T - The type to flatten
 */
export type Flatten<T> = T extends Array<infer U> ? U : T;

/**
 * Removes duplicate values from an array using Set.
 * @template T - The type of array elements
 * @param arr - The array to deduplicate
 * @returns A new array with duplicates removed
 */
export const dedupe = <T>(arr: T[]): T[] => Array.from(new Set(arr));
