export function docSlug(path: string): string {
  return path.replace(/\.md$/, "").replaceAll("/", "--").toLowerCase();
}

export function resolveDocHref(href: string, sourcePath: string): string {
  if (href.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
    return href;
  }

  const resolved = new URL(href, `https://docs.local/docs/${sourcePath}`);
  const target = resolved.pathname.slice(1);
  if (target.startsWith("docs/") && target.endsWith(".md")) {
    return `/docs/${docSlug(target.slice("docs/".length))}${resolved.hash}`;
  }

  return `https://github.com/nickysemenza/cubby/blob/main/${target}${resolved.hash}`;
}
