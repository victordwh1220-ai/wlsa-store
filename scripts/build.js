// Only customer-facing assets go into Vercel's static output directory.
import { mkdir, copyFile, readdir } from "node:fs/promises";
import path from "node:path";

const output = "dist";
const pages = [
  "index.html",
  "dashboard.html",
  "store.js",
  "catalog.js",
  "dashboard.js",
  "store.css",
  "dashboard.css",
];
await mkdir(output, { recursive: true });
for (const file of pages) await copyFile(file, path.join(output, file));

for (const [folder, suffix] of [
  ["assets/products", ".webp"],
  ["assets/fonts", ".woff2"],
]) {
  const dest = path.join(output, folder);
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      await copyFile(
        path.join(folder, entry.name),
        path.join(dest, entry.name),
      );
    }
  }
}
