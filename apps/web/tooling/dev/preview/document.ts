/**
 * The preview's HTML shell. Vite's dev server transforms and hot-reloads the
 * entry module directly; the inline preamble is what @vitejs/plugin-react
 * otherwise injects into an index.html, without which refreshed modules throw.
 */
export const PREVIEW_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fixture preview · Cubby dev</title>
    <link rel="icon" href="/favicon-dev.svg" />
    <script type="module" src="/@vite/client"></script>
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
  </head>
  <body class="bg-background text-foreground antialiased">
    <div id="root"></div>
    <script type="module" src="/tooling/dev/preview/main.tsx"></script>
  </body>
</html>
`;
