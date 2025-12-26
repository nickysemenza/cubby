import type { JSX } from "react";
import type { Result } from "~/misc/result-types";

export const renderValueOrError = <T, E = string>(
  result: Result<T, E>,
  renderValue: (value: T) => JSX.Element | string,
) => {
  if (result.success) {
    return renderValue(result.value);
  }
  return <div className="text-destructive">{`${result.error}`}</div>;
};
