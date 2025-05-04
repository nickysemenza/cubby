"use client";

import { JSX } from "react";
import { JsonEditor } from "json-edit-react";

const JsonRenderer = ({
  input,
  pretty = false,
}: {
  input: unknown;
  pretty?: boolean;
}): JSX.Element => {
  return pretty ? (
    <JsonEditor data={input} viewOnly />
  ) : (
    <pre className="overflow-auto">{JSON.stringify(input, null, 2)}</pre>
  );
};

export default JsonRenderer;
