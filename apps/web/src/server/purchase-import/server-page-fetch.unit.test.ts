import { describe, expect, it } from "vitest";

import { publicPageFetcher } from "./server-page-fetch";

const HOSTS = ["seed.example.test"];
const PAGE = "https://seed.example.test/products/basil?variant=101";
const html = `<html><body>${"Sweet Genovese basil. ".repeat(200)}</body></html>`;

/** A network that redirects `PAGE` to `location`, then serves a page. */
const redirectingTo =
  (location: string): typeof fetch =>
  async (input) =>
    String(input) === PAGE
      ? new Response(null, { status: 302, headers: { location } })
      : new Response(html, { headers: { "content-type": "text/html" } });

// The server once read a redirected page under the URL it asked for: an
// off-site redirect was accepted, and a redirect to another `?variant=` read
// as the requested variant.
describe("a server read of a public product page", () => {
  it("records the URL a redirect actually served", async () => {
    const served = "https://seed.example.test/products/basil?variant=202";
    expect(
      await publicPageFetcher(redirectingTo(served))(PAGE, HOSTS),
    ).toMatchObject({ status: "fetched", url: served });
  });

  it("refuses a redirect off the vendor's hosts before following it", async () => {
    expect(
      await publicPageFetcher(
        redirectingTo("https://login.example.net/signin"),
      )(PAGE, HOSTS),
    ).toMatchObject({
      status: "blocked",
      reason: "redirected off the vendor's site",
    });
  });
});
