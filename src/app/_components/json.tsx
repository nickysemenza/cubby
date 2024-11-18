const JsonRenderer = ({ input }: { input: unknown }): JSX.Element => {
  return <pre>{JSON.stringify(input, null, 2)}</pre>;
};

export default JsonRenderer;
