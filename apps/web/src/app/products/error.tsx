"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import JsonRenderer from "~/app/_components/json-renderer";
import { Button } from "~/components/ui/button";

// biome-ignore lint/suspicious/noShadowRestrictedNames: Next.js error boundary convention
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error(error);
  }, [error]);

  return (
    <div>
      <h2>Something went wrong!</h2>
      <JsonRenderer input={error} />
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
