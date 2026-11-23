// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

let STRICT = false;

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  new: string;
}
type Edit = (tree: Tree) => Move | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- files, lines, matching (SPEC sections 3 and 5) ---------- */

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function serializeLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(lines: string[], pos: number, o: string[], tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) {
    if (lineKey(lines[pos + k]!, tier) !== lineKey(o[k]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (matchesAt(lines, i, o, tier)) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], from: number): { tier: number; occ: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

interface NEntry {
  text: string;
  ctx?: number;
}

/** Build the replacement lines for an occurrence at `pos` (SPEC section 5). */
function buildN(lines: string[], pos: number, o: string[], n: NEntry[], tier: number): string[] {
  if (o.length === 0) return n.map((e) => e.text);
  const f = leadingWs(lines[pos]!);
  const p = leadingWs(o[0]!);
  return n.map((e) => {
    if (e.ctx !== undefined) return lines[pos + e.ctx]!;
    const t = e.text;
    if (tier !== 2) return t;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/* ---------- JSON edits (SPEC section 9, starter) ---------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- unified diffs (SPEC section 6) ---------- */

interface UHunk {
  a: number;
  o: string[];
  n: NEntry[];
  noNL: boolean;
  hasPlus: boolean;
  lastPlusNoNL: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function unifiedPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function applyUnifiedHunks(text: string, hunks: UHunk[], path: string): string {
  const st = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const ins = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = ins === st.lines.length;
      const newLines = h.n.map((e) => e.text);
      st.lines.splice(ins, 0, ...newLines);
      if (atEnd && newLines.length > 0) st.final = !h.noNL;
      d += newLines.length;
    } else {
      const found = findTier(st.lines, h.o, 0);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + h.o.length === st.lines.length;
      const repl = buildN(st.lines, best, h.o, h.n, found.tier);
      st.lines.splice(best, h.o.length, ...repl);
      if (touchesEnd) st.final = !h.noNL;
      d += h.n.length - h.o.length;
    }
  }
  return serializeFile(st);
}

function unifiedSectionEdit(sec: USection): Edit {
  let oldP: string | null = sec.oldPath;
  let newP: string | null = sec.newPath;
  if (!sec.hasPair) {
    if (sec.renameFrom !== null) oldP = sec.renameFrom;
    if (sec.renameTo !== null) newP = sec.renameTo;
  }
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  const isCreate = oldP === null || sec.isCreate;
  const isDelete = newP === null || sec.isDelete;
  return (tree) => {
    if (isCreate) {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plusLines: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (e.ctx === undefined) plusLines.push(e.text);
      let lastPlus: UHunk | null = null;
      for (const h of sec.hunks) if (h.hasPlus) lastPlus = h;
      const final = plusLines.length === 0 ? false : !(lastPlus?.lastPlusNoNL ?? false);
      tree.now.set(np, serializeLines(plusLines, '\n', final));
      return undefined;
    }
    if (isDelete) {
      const op = oldP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return undefined;
    }
    const op = oldP!;
    const np = newP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    if (op !== np) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(tree.get(op)!, sec.hunks, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      return { old: op, new: np };
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    const out = applyUnifiedHunks(tree.get(op)!, sec.hunks, op);
    tree.now.set(op, out);
    return undefined;
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  const newSection = (): USection => {
    const s: USection = { oldPath: null, newPath: null, hasPair: false, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let cur: USection | null = null;
  let curHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.oldPath = m[1]!;
      cur.newPath = m[2]!;
      curHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = unifiedPath(line);
      const newP = unifiedPath(lines[i + 1]!);
      if (cur && curHeader && !cur.hasPair) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
        curHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!cur || curHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      interface Item {
        kind: 'ctx' | 'old' | 'new' | 'bs';
      }
      const items: Item[] = [];
      const o: string[] = [];
      const n: NEntry[] = [];
      for (const bl of body) {
        if (bl.startsWith('\\')) {
          items.push({ kind: 'bs' });
        } else if (bl === '') {
          const ctx = o.length;
          o.push('');
          n.push({ text: '', ctx });
          items.push({ kind: 'ctx' });
        } else if (bl[0] === ' ') {
          const t = bl.slice(1);
          const ctx = o.length;
          o.push(t);
          n.push({ text: t, ctx });
          items.push({ kind: 'ctx' });
        } else if (bl[0] === '-') {
          o.push(bl.slice(1));
          items.push({ kind: 'old' });
        } else if (bl[0] === '+') {
          n.push({ text: bl.slice(1) });
          items.push({ kind: 'new' });
        }
      }
      let noNL = false;
      let lastPlusNoNL = false;
      let hasPlus = false;
      for (let k = 0; k < items.length; k += 1) {
        const kind = items[k]!.kind;
        if (kind === 'ctx' || kind === 'new') {
          const isLast = !items.slice(k + 1).some((x) => x.kind === 'ctx' || x.kind === 'new');
          if (isLast) noNL = k + 1 < items.length && items[k + 1]!.kind === 'bs';
        }
        if (kind === 'new') {
          hasPlus = true;
          const isLastPlus = !items.slice(k + 1).some((x) => x.kind === 'new');
          if (isLastPlus) lastPlusNoNL = k + 1 < items.length && items[k + 1]!.kind === 'bs';
        }
      }
      cur.hunks.push({ a, o, n, noNL, hasPlus, lastPlusNoNL });
      curHeader = false;
      i = j;
      continue;
    }
    if (cur && curHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s));
}

/* ---------- SEARCH/REPLACE blocks (SPEC section 7) ---------- */

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdit(b: SRBlock): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, serializeLines(b.nw, '\n', b.nw.length > 0));
      return undefined;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const st = parseFile(before);
    const found = findTier(st.lines, b.old, 0);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const repl = buildN(
      st.lines,
      pos,
      b.old,
      b.nw.map((t) => ({ text: t })),
      found.tier,
    );
    st.lines.splice(pos, b.old.length, ...repl);
    tree.now.set(p, serializeFile(st));
    return undefined;
  };
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let j = s + 1;
    let eq = -1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      j += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let k = eq + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, eq), nw: lines.slice(eq + 1, k) });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b));
}

/* ---------- V4A patches (SPEC section 8) ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
  o: string[];
  n: NEntry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  updateLine: number;
}

function chunkON(body: string[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const bl of body) {
    if (bl === '') {
      const ctx = o.length;
      o.push('');
      n.push({ text: '', ctx });
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      const ctx = o.length;
      o.push(t);
      n.push({ text: t, ctx });
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1) });
    }
  }
  return { o, n };
}

function findAnchor(lines: string[], anchor: string, from: number): number | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineKey(lines[i]!, tier) === lineKey(anchor, tier)) return i;
    }
  }
  return null;
}

function v4aSectionEdit(sec: VSection): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, serializeLines(sec.lines, '\n', sec.lines.length > 0));
      return undefined;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return undefined;
    }
    const np = sec.moveTo;
    if (np !== null && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    const st = parseFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(st.lines, ch.anchor, cursor);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      if (ch.eof) {
        if (ch.o.length === 0) {
          const repl = ch.n.map((e) => e.text);
          st.lines.splice(st.lines.length, 0, ...repl);
          cursor = st.lines.length;
        } else {
          const targetPos = st.lines.length - ch.o.length;
          if (targetPos < cursor) throw new Fail('no-match', p);
          const tiers = STRICT ? [0] : [0, 1, 2];
          let tierFound: number | null = null;
          for (const tier of tiers) {
            if (matchesAt(st.lines, targetPos, ch.o, tier)) {
              tierFound = tier;
              break;
            }
          }
          if (tierFound === null) throw new Fail('no-match', p);
          const repl = buildN(st.lines, targetPos, ch.o, ch.n, tierFound);
          st.lines.splice(targetPos, ch.o.length, ...repl);
          cursor = targetPos + repl.length;
        }
      } else if (ch.o.length === 0) {
        const repl = ch.n.map((e) => e.text);
        st.lines.splice(cursor, 0, ...repl);
        cursor += repl.length;
      } else {
        const found = findTier(st.lines, ch.o, cursor);
        if (!found) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        const repl = buildN(st.lines, pos, ch.o, ch.n, found.tier);
        st.lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = serializeFile(st);
    if (np !== null) {
      tree.now.set(np, out);
      tree.now.set(p, null);
      return { old: p, new: np };
    }
    tree.now.set(p, out);
    return undefined;
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secStart = i;
    i += 1;
    if (kind === 'add') {
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const flines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) flines.push(r.text.slice(1));
        else if (r.text === '') flines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, lines: flines, moveTo: null, chunks: [], updateLine: secStart + 1 });
    } else if (kind === 'delete') {
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      sections.push({ kind, path, lines: [], moveTo: null, chunks: [], updateLine: secStart + 1 });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('*** Move to:')) {
          if (moveTo !== null || chunks.length > 0 || cur !== null) throw new Exit2(`error: parse ${i + 1}`);
          moveTo = l.slice('*** Move to:'.length).trim();
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          pushCur();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          pushCur();
          cur = { anchor: l.slice(2).trim(), eof: false, body: [], o: [], n: [] };
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!cur) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [], o: [], n: [] };
          }
          cur.body.push(l);
          i += 1;
          continue;
        }
        if (blank(l)) {
          let j = i;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || isSectionStart(lines[j]!)) break;
          throw new Exit2(`error: parse ${i + 1}`);
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushCur();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      for (const ch of chunks) {
        const on = chunkON(ch.body);
        ch.o = on.o;
        ch.n = on.n;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secStart + 1}`);
      sections.push({ kind, path, lines: [], moveTo, chunks, updateLine: secStart + 1 });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s));
}

/* ---------- run ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  STRICT = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rowObjs: { key: string; text: string }[] = [];
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      consumed.add(mv.old);
      consumed.add(mv.new);
      rowObjs.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
    }
  }
  const byteSort = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()].sort(byteSort)) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowObjs.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowObjs.sort((a, b) => byteSort(a.key, b.key));
  const rows = rowObjs.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort(byteSort)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
