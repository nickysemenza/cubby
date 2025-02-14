import { JSX } from "react";

const JsonRenderer = ({ input }: { input: unknown }): JSX.Element => {
  return <pre className="overflow-auto">{JSON.stringify(input, null, 2)}</pre>;
};

export default JsonRenderer;
