import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";

import { browserOnlyLazy } from "./browser-only-lazy";

describe("browserOnlyLazy", () => {
  // A dialog or popover body keeps the caller's own loading UI while its
  // chunk downloads; an inner no-op boundary used to swallow it.
  it("without a placeholder, suspends to the caller's Suspense fallback", async () => {
    let resolve!: (module: { default: () => React.JSX.Element }) => void;
    const Panel = browserOnlyLazy<object>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(
      <Suspense fallback={<p>Loading panel…</p>}>
        <Panel />
      </Suspense>,
    );
    expect(await screen.findByText("Loading panel…")).toBeInTheDocument();
    resolve({ default: () => <p>Panel</p> });
    expect(await screen.findByText("Panel")).toBeInTheDocument();
  });
});
