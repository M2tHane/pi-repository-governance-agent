import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/admin/assets", { recursive: true });
await Promise.all([
  build({ entryPoints: ["frontend/app.tsx"], bundle: true, minify: true, outfile: "dist/admin/assets/app.js", format: "esm", target: "es2022" }),
  cp("frontend/index.html", "dist/admin/index.html"),
  cp("frontend/app.css", "dist/admin/assets/app.css"),
]);
