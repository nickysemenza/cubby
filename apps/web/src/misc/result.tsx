import type { JSX } from "react";
import type { Result } from "~/misc/result-types";

export const renderValueOrError = <T, E = string>(
  result: Result<T, E>,
  renderValue: (value: T) => JSX.Element | string,
) => {
  if (result.isOk()) {
    return renderValue(result.value);
  }
  return <div className="text-destructive">{`${result.error}`}</div>;
};

/**
 * Like {@link renderValueOrError}, but treats a failure as missing data rather
 * than an error: renders a subtle muted em-dash placeholder with the detail
 * available on hover (via `title`). Use this for *expected* conversion gaps
 * (e.g. an ingredient with no unit mapping) so they don't read like a crash.
 */
export const renderValueOrMissing = <T, E = string>(
  result: Result<T, E>,
  renderValue: (value: T) => JSX.Element | string,
) => {
  if (result.isOk()) {
    return renderValue(result.value);
  }
  return (
    <span
      className="cursor-default text-muted-foreground"
      title={`${result.error}`}
    >
      —
    </span>
  );
};
