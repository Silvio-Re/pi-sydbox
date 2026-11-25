/**
 * syd violation-record parsing.
 *
 * Real lines from syd 3.59/3.60 carry more than the access fields: every line
 * may hold id, pid, time, level, cmd, cwd, uid, arch and args, network
 * violations carry addr, unix and ipv instead of path, and notices carry level
 * and msg with no act at all. Notices are not violations: they are counted and
 * skipped, never parsed as records.
 *
 * KNOWN_FIELDS was documentation-derived until the first real record was
 * captured from the engine built here
 * (test/fixtures/syd-3.59.0-access-deny.jsonl). That sample added hid, syd and
 * tty, and showed err carrying an errno number rather than text. A key the list
 * does not cover is collected in `record.unknown` instead of being fatal,
 * because a new release may add one at any time; `{ strict: true }` turns an
 * unknown key back into SchemaDriftError. Drift reporting must never block a
 * record from reaching the caller.
 */

export class SchemaDriftError extends Error {}

/** Sandbox actions a syd log line may carry. */
export type Act = "allow" | "warn" | "filter" | "deny" | "panic" | "stop" | "abort" | "kill" | "exit";

const ACTS: ReadonlySet<string> = new Set<Act>([
  "allow",
  "warn",
  "filter",
  "deny",
  "panic",
  "stop",
  "abort",
  "kill",
  "exit",
]);

/** Fields documented for the syd versions this parser was written against.
 * Verified against captured engine logs
 * (test/fixtures/capture/*.jsonl); `ctl` was added from those captures. */
export const KNOWN_FIELDS_VERSION = "syd 3.59.0 (captured)" as const;

export const KNOWN_FIELDS = [
  "id",
  "ctx",
  "cap",
  "act",
  "pid",
  "path",
  "addr",
  "unix",
  "ipv",
  "abs",
  "sys",
  "arch",
  "args",
  "cmd",
  "cwd",
  "uid",
  "level",
  "time",
  "err",
  "msg",
  "tip",
  "type",
  "hid",
  "syd",
  "tty",
  "ctl",
] as const;

export type KnownField = (typeof KNOWN_FIELDS)[number];

/** Fields every access record must carry: a non-empty trimmed string.
 * `cap` additionally accepts an array — a captured 3.59.0 denial carries
 * `"cap":["read","write"]` with tip `allow/read,write+…`, the compound
 * engine spelling (fixtures/capture) — so `cap` is validated by `parseCap`,
 * not by this list. */
export const REQUIRED_FIELDS = ["act", "sys"] as const;

/** Parser options. `strict` turns an unknown field back into drift by default. */
interface ParseOptions {
  strict?: boolean;
}

const ALLOWED: ReadonlySet<string> = new Set<string>(KNOWN_FIELDS);

/** Normalise a raw act value. Anything outside the known set is drift. */
export function normalizeAct(value: string): Act {
  const normalized = value.trim().toLowerCase();
  if (!ACTS.has(normalized)) {
    throw new SchemaDriftError(`unknown act: ${JSON.stringify(value)} (schema drift, upgrade blocked)`);
  }
  return normalized as Act;
}

export interface SydRecord {
  act: Act;
  cap: string;
  sys: string;
  ctx?: string;
  id?: string;
  pid?: number;
  time?: string;
  level?: string;
  cmd?: string;
  cwd?: string;
  uid?: number;
  arch?: string;
  args?: unknown;
  /** Errno as a number in captured records, text in documentation samples. */
  err?: string | number;
  msg?: string;
  tip?: string;
  ipv?: 4 | 6;
  abs?: boolean;
  /** Object kind ("reg"/"dir") on path records that carry it (doc-derived). */
  type?: string;
  /** Keys outside KNOWN_FIELDS, kept in lenient mode. Never an empty object. */
  unknown?: Record<string, unknown>;
}

export interface PathRecord extends SydRecord {
  kind: "path";
  path: string;
}

export interface NetRecord extends SydRecord {
  kind: "net";
  addr?: string;
  unix?: string;
}

/** A device/state denial with no path target: ioctl group names in `ctl`
 * (captured 3.59.0: `"cap":"ioctl","ctl":["TCGETS"]`, tip `allow/ioctl+TCGETS`). */
export interface CtlRecord extends SydRecord {
  kind: "ctl";
  ctl: string[];
}

export type AnyRecord = PathRecord | NetRecord | CtlRecord;

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaDriftError("record is not an object");
  }
  return raw as Record<string, unknown>;
}

function present(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] !== undefined && obj[key] !== null;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!present(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value !== "string") {
    throw new SchemaDriftError(`field ${key} is not a string (schema drift, upgrade blocked)`);
  }
  return value;
}

function optionalStringOrNumber(
  obj: Record<string, unknown>,
  key: string,
): string | number | undefined {
  if (!present(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new SchemaDriftError(
    `field ${key} is neither string nor number (schema drift, upgrade blocked)`,
  );
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  if (!present(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new SchemaDriftError(`field ${key} is not a number (schema drift, upgrade blocked)`);
}

function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  if (!present(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new SchemaDriftError(`field ${key} is not a boolean (schema drift, upgrade blocked)`);
}

function optionalIpv(obj: Record<string, unknown>): 4 | 6 | undefined {
  if (!present(obj, "ipv")) return undefined;
  const value = obj["ipv"];
  if (value === 4 || value === "4") return 4;
  if (value === 6 || value === "6") return 6;
  throw new SchemaDriftError(`field ipv is not 4 or 6 (schema drift, upgrade blocked)`);
}

/** A valid `cap`: the single spelling, or the comma-joined compound of a
 * non-empty array (deduplicated, order kept) — exactly the engine's own
 * `read,write` spelling from its tip, so the mapper can split it back. */
function parseCap(value: unknown): string {
  const single = (v: unknown): string | null => {
    if (typeof v !== "string" || v.trim() === "") return null;
    return v.trim();
  };
  const one = single(value);
  if (one !== null) return one;
  if (Array.isArray(value)) {
    const caps: string[] = [];
    for (const entry of value) {
      const cap = single(entry);
      if (cap === null) {
        throw new SchemaDriftError("cap array holds an empty or non-string entry (schema drift, upgrade blocked)");
      }
      if (!caps.includes(cap)) caps.push(cap);
    }
    if (caps.length === 0) throw new SchemaDriftError("cap array is empty (schema drift, upgrade blocked)");
    return caps.join(",");
  }
  throw new SchemaDriftError("field cap is neither string nor string array (schema drift, upgrade blocked)");
}

/** A valid `ctl`: one name or an array of them, always returned as an array. */
function parseCtl(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const single = (v: unknown): string | null => {
    if (typeof v !== "string" || v.trim() === "") return null;
    return v.trim();
  };
  const names: string[] = [];
  if (single(value) !== null) {
    names.push(single(value) as string);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      const name = single(entry);
      if (name === null) {
        throw new SchemaDriftError("ctl array holds an empty or non-string entry (schema drift, upgrade blocked)");
      }
      if (!names.includes(name)) names.push(name);
    }
    if (names.length === 0) throw new SchemaDriftError("ctl array is empty (schema drift, upgrade blocked)");
  } else {
    throw new SchemaDriftError("field ctl is neither string nor string array (schema drift, upgrade blocked)");
  }
  return names;
}

/**
 * Parse one decoded log line. A record with a valid act is an access record;
 * it must carry act, cap and sys and one of path or addr/unix.
 */
export function parseRecord(raw: unknown, options: ParseOptions = {}): AnyRecord {
  const obj = asObject(raw);

  const unknownKeys = Object.keys(obj).filter((key) => !ALLOWED.has(key));
  if (unknownKeys.length > 0 && options.strict === true) {
    throw new SchemaDriftError(
      `unknown record field(s): ${unknownKeys.join(", ")} (schema drift, upgrade blocked)`,
    );
  }

  const missing = REQUIRED_FIELDS.filter((key) => {
    if (typeof obj[key] !== "string") return true;
    return (obj[key] as string).trim().length === 0;
  });
  if (missing.length > 0) {
    throw new SchemaDriftError(`missing or non-string field(s): ${missing.join(", ")}`);
  }

  const cap = parseCap(obj.cap);

  const record: SydRecord = {
    act: normalizeAct(obj.act as string),
    cap,
    sys: (obj.sys as string).trim(),
  };

  const ctx = optionalString(obj, "ctx");
  if (ctx !== undefined) record.ctx = ctx;
  const id = optionalString(obj, "id");
  if (id !== undefined) record.id = id;
  const pid = optionalNumber(obj, "pid");
  if (pid !== undefined) record.pid = pid;
  const time = optionalString(obj, "time");
  if (time !== undefined) record.time = time;
  const level = optionalString(obj, "level");
  if (level !== undefined) record.level = level;
  const cmd = optionalString(obj, "cmd");
  if (cmd !== undefined) record.cmd = cmd;
  const cwd = optionalString(obj, "cwd");
  if (cwd !== undefined) record.cwd = cwd;
  const uid = optionalNumber(obj, "uid");
  if (uid !== undefined) record.uid = uid;
  const arch = optionalString(obj, "arch");
  if (arch !== undefined) record.arch = arch;
  const err = optionalStringOrNumber(obj, "err");
  if (err !== undefined) record.err = err;
  const msg = optionalString(obj, "msg");
  if (msg !== undefined) record.msg = msg;
  const tip = optionalString(obj, "tip");
  if (tip !== undefined) record.tip = tip;
  const ipv = optionalIpv(obj);
  if (ipv !== undefined) record.ipv = ipv;
  const abs = optionalBoolean(obj, "abs");
  if (abs !== undefined) record.abs = abs;
  // `type` ("reg"/"dir"/"chr"…) was declared on the interface but never copied
  // before, so every mapper branch keyed on it was reading undefined.
  const type = optionalString(obj, "type");
  if (type !== undefined) record.type = type;
  if (present(obj, "args")) record.args = obj["args"];
  if (unknownKeys.length > 0) {
    const extra: Record<string, unknown> = {};
    for (const key of unknownKeys) extra[key] = obj[key];
    record.unknown = extra;
  }

  const path = typeof obj.path === "string" ? obj.path : "";
  if (path.trim().length > 0) {
    return { ...record, kind: "path", path };
  }

  const addr = typeof obj.addr === "string" ? obj.addr : undefined;
  const unix = typeof obj.unix === "string" ? obj.unix : undefined;
  const hasAddr = addr !== undefined && addr.trim().length > 0;
  const hasUnix = unix !== undefined && unix.trim().length > 0;
  const ctl = parseCtl(obj.ctl);
  if (!hasAddr && !hasUnix) {
    // Not every denial names a path: ioctl group denials carry their group
    // names in `ctl` and no target at all (captured) — they stay grantable
    // through their own rule form instead of being lost as drift.
    if (ctl !== undefined && record.cap === "ioctl") {
      return { ...record, kind: "ctl", ctl };
    }
    throw new SchemaDriftError(
      "access record carries neither path nor addr/unix (schema drift, upgrade blocked)",
    );
  }

  const net: NetRecord = { ...record, kind: "net" };
  if (hasAddr) net.addr = addr;
  if (hasUnix) net.unix = unix;
  return net;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function decodeLine(line: string): JsonValue {
  const trimmed = line.trim();
  if (trimmed.length === 0) throw new SchemaDriftError("empty log line");
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch (err) {
    throw new SchemaDriftError(`not JSON: ${(err as Error).message}`);
  }
}

/** Parse one log line as an access record. */
export function parseLine(line: string, options: ParseOptions = {}): AnyRecord {
  return parseRecord(decodeLine(line), options);
}

/**
 * Parse one log line, returning null when the line is a notice rather than a
 * violation. Non-JSON and empty input still throw.
 */
export function tryParseAccessLine(line: string, options: ParseOptions = {}): AnyRecord | null {
  const decoded = decodeLine(line);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new SchemaDriftError("record is not an object");
  }
  if (!("act" in (decoded as { [key: string]: JsonValue }))) return null;
  return parseRecord(decoded, options);
}

/** Parse a whole log body. Blank lines are ignored, notices are counted. */
export function parseLog(
  text: string,
  options: ParseOptions = {},
): { records: AnyRecord[]; skipped: number } {
  const records: AnyRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = tryParseAccessLine(line, options);
    if (record === null) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}
