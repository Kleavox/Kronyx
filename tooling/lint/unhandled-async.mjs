import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const roots = ["app", "packages"];

const HANDLER =
  /\bon(?:Click|Submit|Change|Blur|Input|KeyDown)=\{\s*async\b|=\s*async\s*\([^)]*\)\s*(?::[^=]+)?=>/g;

const DECLARED = /\basync\s+function\s+(\w+)\s*\(/g;

function wiredToAnEvent(source, name) {
  const asHandler = new RegExp(
    "on(?:Click|Submit|Change|Blur|Input|KeyDown)=\\{\\s*" + name + "\\s*\\}",
  );
  const voided = new RegExp("void\\s+" + name + "\\s*\\(");
  return asHandler.test(source) || voided.test(source);
}

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
    if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function bodyAt(source, from) {
  let depth = 0;
  let started = false;
  let body = "";
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      started = true;
    } else if (character === "}") {
      depth -= 1;
    }
    if (started) body += character;
    if (started && depth === 0) break;
  }
  return body;
}

const offenders = [];
for (const name of roots) {
  let files = [];
  try {
    files = collect(resolve(root, name));
  } catch {
    continue;
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sanctioned = /\buseAction\b/.test(source);
    const flag = (index) => {
      const body = bodyAt(source, index);
      if (!/\bawait\b/.test(body)) return;
      if (/\bcatch\s*[({]/.test(body) || /\.catch\s*\(/.test(body)) return;
      if (sanctioned && /\brun\s*\(/.test(body)) return;
      offenders.push({
        file: relative(root, file).split("\\").join("/"),
        line: source.slice(0, index).split("\n").length,
      });
    };

    HANDLER.lastIndex = 0;
    let match;
    while ((match = HANDLER.exec(source))) flag(match.index);

    DECLARED.lastIndex = 0;
    let declared;
    while ((declared = DECLARED.exec(source))) {
      if (wiredToAnEvent(source, declared[1])) flag(declared.index);
    }
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    "Async handlers that discard their failure:\n" +
      offenders
        .map((offender) => "  " + offender.file + ":" + offender.line)
        .join("\n") +
      "\n\nEvery await in an event handler can reject. A rejection nobody\n" +
      "catches leaves the click doing nothing and says nothing to the user.\n" +
      "Run the work through a mutation that reports onError, or\n" +
      "catch it where it happens.\n",
  );
  process.exit(1);
}

process.stdout.write("Async error handling: clean\n");
