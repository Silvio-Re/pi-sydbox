import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryParseAccessLine, type AnyRecord } from "../src/records.ts";

/**
 * Strict parsing must be clean on the repository's own captures: KNOWN_FIELDS
 * claims the captures were read, so every field any committed fixture carries
 * has to be on the list. A new capture that fails this test means the list
 * drifted again and the "syd 3.59.0 (captured)" claim is false until it is
 * fixed (P0 roadmap, order of record).
 */

const FIXTURES_DIR = new URL("./fixtures", import.meta.url).pathname;

function jsonlFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonlFiles(path));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found.sort();
}

test("strict parsing is clean on every committed fixture", () => {
  const files = jsonlFiles(FIXTURES_DIR);
  assert.ok(files.length >= 3, `expected the committed fixtures, found ${files.length}`);
  for (const file of files) {
    let records = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      // Strict: an unknown key throws here, so the line-by-line loop is the
      // assertion — no drift on the repository's own captures.
      const record: AnyRecord | null = tryParseAccessLine(line, { strict: true });
      if (record !== null) records += 1;
    }
    assert.ok(records > 0, `${file}: a capture fixture must hold at least one access record`);
  }
});
