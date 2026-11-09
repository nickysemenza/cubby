import { describe, expect, it } from "vitest";

import { retainLiteralLineLinks } from "./extract";

describe("order confirmation line links", () => {
  const html =
    '<a href="https://seeds.example.test/products/tomato?variant=7">Tomato seeds</a>' +
    '<img src="https://cdn.example.test/tomato_small.jpg" alt="Tomato seeds">' +
    '<a href="https://click.mail.example.test/r/abc">Pepper seeds</a>';
  const line = (
    title: string,
    productUrl: string | null,
    imageUrl: string | null,
  ) => ({
    title,
    amount: 2,
    lineKind: "principal" as const,
    quantity: 1,
    productUrl: productUrl ?? undefined,
    imageUrl: imageUrl ?? undefined,
    sku: null,
    seller: null,
  });
  const retainLinks = (value: ReturnType<typeof line>) =>
    retainLiteralLineLinks(value, { bodyText: null, bodyHtml: html }, [
      "seeds.example.test",
    ]);

  it("keeps a product link and image the email literally shows", () => {
    expect(
      retainLinks(
        line(
          "Tomato seeds",
          "https://seeds.example.test/products/tomato?variant=7",
          "https://cdn.example.test/tomato_small.jpg",
        ),
      ),
    ).toMatchObject({
      productUrl: "https://seeds.example.test/products/tomato?variant=7",
      imageUrl: "https://cdn.example.test/tomato_small.jpg",
    });
  });

  it("drops a URL that is only a prefix of a longer link in the email", () => {
    expect(
      retainLinks(
        line(
          "Tomato seeds",
          "https://seeds.example.test/products/tomato",
          null,
        ),
      ).productUrl,
    ).toBeUndefined();
  });

  it("drops an invented URL and a tracking redirect off the Vendor's site", () => {
    const tomato = retainLinks(
      line(
        "Tomato seeds",
        "https://seeds.example.test/products/made-up",
        "https://cdn.example.test/invented.jpg",
      ),
    );
    const pepper = retainLinks(
      line("Pepper seeds", "https://click.mail.example.test/r/abc", null),
    );
    expect(tomato.productUrl).toBeUndefined();
    expect(tomato.imageUrl).toBeUndefined();
    expect(pepper.productUrl).toBeUndefined();
  });
});
