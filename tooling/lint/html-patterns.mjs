import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const roots = ["app", "packages"];

function collect(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        ["node_modules", "dist", ".turbo", ".wrangler"].includes(entry.name)
      ) {
        continue;
      }
      collect(path, found);
      continue;
    }
    if (/\.(tsx|html)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const broken = [];
for (const name of roots) {
  let files = [];
  try {
    files = collect(resolve(root, name));
  } catch {
    continue;
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bpattern=["']([^"']+)["']/g)) {
      try {
        new RegExp(match[1], "v");
      } catch (cause) {
        broken.push({
          file: relative(root, file).split("\\").join("/"),
          line: source.slice(0, match.index).split("\n").length,
          pattern: match[1],
          reason: cause.message,
        });
      }
    }
  }
}

if (broken.length > 0) {
  process.stderr.write(
    "HTML pattern attributes that no browser will apply:\n" +
      broken
        .map(
          (entry) =>
            "  " +
            entry.file +
            ":" +
            entry.line +
            "  " +
            entry.pattern +
            "\n      " +
            entry.reason,
        )
        .join("\n") +
      "\n\nA pattern attribute is compiled as a unicode-sets regex. One that\n" +
      "does not compile is dropped silently, so the field validates nothing\n" +
      "while still looking validated. Escape the offending character.\n",
  );
  process.exit(1);
}

process.stdout.write("HTML pattern attributes: all compile\n");
