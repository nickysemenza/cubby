import { describe, expect, it } from "vitest";
import { readCubbyOrigin, withCubbyOrigin } from "./origin";

/** A stand-in for a built bundle: the meta tag plus inlined app JS. */
const BUNDLE = `<!doctype html><html><head>
<meta name="cubby-origin" content="__CUBBY_ORIGIN__" />
</head><body><script type="module">const P="__CUBBY_ORIGIN__";console.log(P)</script></body></html>`;

function docFor(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("withCubbyOrigin", () => {
  it("substitutes the meta tag", () => {
    const out = withCubbyOrigin(BUNDLE, "https://cubby.example.com");
    expect(readCubbyOrigin(docFor(out))).toBe("https://cubby.example.com");
  });

  it("leaves the placeholder inside inlined app JS alone", () => {
    // Regression: a document-wide `replaceAll` also rewrote the placeholder
    // constant compiled into the app's own bundle. The app compared the meta
    // value against that constant to detect "not substituted" — so after
    // substitution both sides were the origin, the check matched, and every
    // deep link silently did nothing. Never reached a test because the harness
    // rewrote the document exactly the same way the server did.
    const out = withCubbyOrigin(BUNDLE, "https://cubby.example.com");
    expect(out).toContain('const P="__CUBBY_ORIGIN__"');
    expect(out.match(/https:\/\/cubby\.example\.com/g)).toHaveLength(1);
  });
});

describe("readCubbyOrigin", () => {
  it("returns null when the placeholder was never substituted", () => {
    expect(readCubbyOrigin(docFor(BUNDLE))).toBeNull();
  });

  it("returns null when the meta tag is absent", () => {
    expect(readCubbyOrigin(docFor("<html><body></body></html>"))).toBeNull();
  });

  it("rejects a non-http scheme", () => {
    const out = withCubbyOrigin(BUNDLE, "javascript:alert(1)");
    expect(readCubbyOrigin(docFor(out))).toBeNull();
  });

  it("normalizes to the bare origin", () => {
    const out = withCubbyOrigin(BUNDLE, "https://cubby.example.com/some/path");
    expect(readCubbyOrigin(docFor(out))).toBe("https://cubby.example.com");
  });
});
