export type Flatten<T> = T extends Array<infer U> ? U : T;

export const dedupe = <T>(arr: T[]): T[] => Array.from(new Set(arr));

export type Result<T, E = string> =
  | { success: true; value: T; error?: never }
  | { success: false; value?: never; error: E };

export const withSuccess = <T, E = string>(value: T): Result<T, E> => ({
  success: true,
  value,
});
export const withFailure = <T, E = string>(error: E): Result<T, E> => ({
  success: false,
  error,
});
