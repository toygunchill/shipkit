#!/usr/bin/env node
// Recompute every hash in tests/fixtures/fingerprint-vectors.json from the
// TypeScript implementation, which is the one the fixture is generated from.
//
// The hashes are never hand-written. Whenever the canonical form changes —
// a new bound field, a new version marker — every vector's hash changes with
// it, and typing 64 hex digits from a terminal is how a fixture stops being a
// contract and starts being a transcription of whatever the code did.
//
//   npm run build && node scripts/fingerprint-vectors.mjs
//
// Only the `"fingerprint"` values are rewritten; the situations are left byte
// for byte as they were authored. That matters because some vectors carry
// deliberate `\uXXXX` escapes — a combining mark next to a precomposed
// character is invisible in a text editor, and re-serialising the file through
// JSON.stringify would flatten those escapes into raw UTF-8 and hide the very
// difference the vector exists to pin down.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fingerprint } from "../dist/approval/fingerprint.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "tests/fixtures/fingerprint-vectors.json");

const source = readFileSync(path, "utf8");
const vectors = JSON.parse(source);
const hashes = vectors.map((vector) => fingerprint(vector.situation));

let index = 0;
const updated = source.replace(/("fingerprint":\s*")[^"]*(")/g, (_match, open, close) => {
  if (index >= hashes.length) throw new Error("more fingerprint keys than vectors");
  return `${open}${hashes[index++]}${close}`;
});
if (index !== hashes.length) throw new Error(`rewrote ${index} of ${hashes.length} hashes`);

writeFileSync(path, updated);
for (const [i, vector] of vectors.entries()) {
  console.log(`${hashes[i]}  ${vector.name}`);
}
