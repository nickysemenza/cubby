export function docSlug(path: string): string {
  return path.replace(/\.md$/, "").replaceAll("/", "--").toLowerCase();
}

/** `sourcePath` is relative to `docs/guide/`, the only Markdown the app bundles. */
export function resolveDocHref(href: string, sourcePath: string): string {
  if (href.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
    return href;
  }

  const resolved = new URL(href, `https://docs.local/docs/guide/${sourcePath}`);
  const target = resolved.pathname.slice(1);
  if (target.startsWith("docs/guide/") && target.endsWith(".md")) {
    return `/docs/${docSlug(target.slice("docs/guide/".length))}${resolved.hash}`;
  }

  return `https://github.com/nickysemenza/cubby/blob/main/${target}${resolved.hash}`;
}
