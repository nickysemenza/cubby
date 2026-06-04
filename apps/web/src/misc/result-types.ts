import type { Result as NeverthrowResult } from "neverthrow";

/**
 * Project-wide `Result` is `neverthrow`'s `Result` with a `string` error
 * default, so the common case (`Result<WAmount>`, string-message failures)
 * stays single-arg. Construct with `ok`/`err` imported directly from
 * `neverthrow`; inspect with `.isOk()`/`.isErr()` and read `.value`/`.error`.
 */
export type Result<T, E = string> = NeverthrowResult<T, E>;
