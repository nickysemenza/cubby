"use client";

import { JsonEditor } from "json-edit-react";
import type { JSX } from "react";

const JsonRenderer = ({
  input,
  pretty = false,
}: {
  input: unknown;
  pretty?: boolean;
}): JSX.Element => {
  return pretty ? (
    <JsonEditor data={input} rootFontSize="10px" viewOnly />
  ) : (
    <pre className="overflow-auto">{JSON.stringify(input, null, 2)}</pre>
  );
};

export default JsonRenderer;
