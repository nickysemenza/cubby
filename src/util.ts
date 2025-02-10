export type Flatten<T> = T extends Array<infer U> ? U : T;

export const dedupe = <T>(arr: T[]): T[] => Array.from(new Set(arr));
