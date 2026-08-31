import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntityRelationshipsDiagram } from "./entity-relationships-diagram";

describe("EntityRelationshipsDiagram", () => {
  it("renders every generated logical relationship", () => {
    render(<EntityRelationshipsDiagram />);

    for (const label of [
      "Components · many · explicit",
      "Containing kits · many · explicit",
      "Products · many · expense + explicit",
      "Parent location · one · parent",
    ]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });
});
