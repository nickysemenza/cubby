import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = new URL(".", import.meta.url);
const result = await build({
  entryPoints: [new URL("ui.mjs", root).pathname],
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
});
const shell = await readFile(new URL("shell.html", root), "utf8");
await mkdir(new URL("public/", root), { recursive: true });
await writeFile(
  new URL("public/index.html", root),
  shell.replace("/*PROTOTYPE_SCRIPT*/", () =>
    result.outputFiles[0].text.replaceAll("</script", "<\\/script"),
  ),
);
console.log(
  "Built self-contained public/index.html; no server or external scripts required.",
);
