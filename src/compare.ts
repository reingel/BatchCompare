import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type DiffStatus = 'same' | 'modified' | 'onlyLeft' | 'onlyRight';

export interface DiffNode {
  name: string;
  relPath: string;
  isDirectory: boolean;
  status: DiffStatus;
  children?: DiffNode[];
}

export interface CompareOptions {
  // true면 화이트스페이스 차이도 다른 것으로 취급, false면 무시하고 비교
  includeWhitespace: boolean;
  // true면 주석 차이도 다른 것으로 취급, false면 주석을 제거하고 비교
  includeComments: boolean;
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  includeWhitespace: false,
  includeComments: true,
};

export type ExcludeMatcher = (name: string, relPath: string) => boolean;

/** Escape a literal (non-wildcard) run for use inside a RegExp. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a single glob pattern to a RegExp.
 * Supports `*` (any run of non-slash chars), `**` (any run including slashes),
 * and `?` (a single non-slash char). Anything else is matched literally.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Build a matcher from exclude patterns. A pattern matches when it equals the
 * entry name or path, or when its glob form matches either. Patterns without a
 * slash are tested against the entry's base name so `*.log` excludes files at
 * any depth; patterns with a slash are tested against the path relative to the
 * compare root.
 */
export function createExcludeMatcher(patterns: string[]): ExcludeMatcher {
  const compiled = patterns.map((pattern) => ({
    hasSlash: pattern.includes('/'),
    isGlob: /[*?]/.test(pattern),
    re: globToRegExp(pattern),
    raw: pattern,
  }));
  return (name, relPath) => {
    for (const p of compiled) {
      const target = p.hasSlash ? relPath : name;
      if (p.isGlob ? p.re.test(target) : target === p.raw) {
        return true;
      }
    }
    return false;
  };
}

export async function compareFolders(
  leftRoot: string,
  rightRoot: string,
  exclude: string[],
  options: CompareOptions = DEFAULT_COMPARE_OPTIONS
): Promise<DiffNode[]> {
  const isExcluded = createExcludeMatcher(exclude);
  return compareDir(leftRoot, rightRoot, '', isExcluded, options);
}

async function compareDir(
  leftDir: string,
  rightDir: string,
  relPath: string,
  exclude: ExcludeMatcher,
  options: CompareOptions
): Promise<DiffNode[]> {
  const [leftEntries, rightEntries] = await Promise.all([
    readEntries(leftDir),
    readEntries(rightDir),
  ]);

  const names = new Set([...leftEntries.keys(), ...rightEntries.keys()]);
  const nodes: DiffNode[] = [];

  for (const name of names) {
    const childRelPath = relPath ? `${relPath}/${name}` : name;
    if (exclude(name, childRelPath)) {
      continue;
    }
    const left = leftEntries.get(name);
    const right = rightEntries.get(name);

    if (left && right) {
      if (left.isDirectory() && right.isDirectory()) {
        const children = await compareDir(
          path.join(leftDir, name),
          path.join(rightDir, name),
          childRelPath,
          exclude,
          options
        );
        const allSame = children.every((c) => c.status === 'same');
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: true,
          status: allSame ? 'same' : 'modified',
          children,
        });
      } else if (!left.isDirectory() && !right.isDirectory()) {
        const equal = await filesEqual(
          path.join(leftDir, name),
          path.join(rightDir, name),
          options
        );
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: false,
          status: equal ? 'same' : 'modified',
        });
      } else {
        // One side is a directory, the other a file — different kinds
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: false,
          status: 'modified',
        });
      }
    } else {
      const entry = (left ?? right)!;
      const side: DiffStatus = left ? 'onlyLeft' : 'onlyRight';
      if (entry.isDirectory()) {
        const dir = path.join(left ? leftDir : rightDir, name);
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: true,
          status: side,
          children: await scanOneSide(dir, childRelPath, side, exclude),
        });
      } else {
        nodes.push({
          name,
          relPath: childRelPath,
          isDirectory: false,
          status: side,
        });
      }
    }
  }

  return sortNodes(nodes);
}

async function scanOneSide(
  dir: string,
  relPath: string,
  status: DiffStatus,
  exclude: ExcludeMatcher
): Promise<DiffNode[]> {
  const entries = await readEntries(dir);
  const nodes: DiffNode[] = [];
  for (const [name, entry] of entries) {
    const childRelPath = `${relPath}/${name}`;
    if (exclude(name, childRelPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      nodes.push({
        name,
        relPath: childRelPath,
        isDirectory: true,
        status,
        children: await scanOneSide(path.join(dir, name), childRelPath, status, exclude),
      });
    } else {
      nodes.push({ name, relPath: childRelPath, isDirectory: false, status });
    }
  }
  return sortNodes(nodes);
}

async function readEntries(dir: string): Promise<Map<string, fs.Dirent>> {
  const map = new Map<string, fs.Dirent>();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

async function filesEqual(
  leftPath: string,
  rightPath: string,
  options: CompareOptions
): Promise<boolean> {
  let leftStat: fs.Stats;
  let rightStat: fs.Stats;
  try {
    [leftStat, rightStat] = await Promise.all([
      fs.promises.stat(leftPath),
      fs.promises.stat(rightPath),
    ]);
  } catch {
    return false;
  }
  const normalize = !options.includeWhitespace || !options.includeComments;

  // 바이트 단위로 동일하면 어떤 옵션에서도 동일하므로 해시로 빠르게 판정한다.
  if (leftStat.size === rightStat.size) {
    const [leftHash, rightHash] = await Promise.all([
      hashFile(leftPath),
      hashFile(rightPath),
    ]);
    if (leftHash === rightHash) {
      return true;
    }
    if (!normalize) {
      return false;
    }
  } else if (!normalize) {
    return false;
  }

  // 공백/주석을 무시하는 비교: 텍스트로 읽어 정규화 후 비교한다.
  let leftBuf: Buffer;
  let rightBuf: Buffer;
  try {
    [leftBuf, rightBuf] = await Promise.all([
      fs.promises.readFile(leftPath),
      fs.promises.readFile(rightPath),
    ]);
  } catch {
    return false;
  }
  if (isBinary(leftBuf) || isBinary(rightBuf)) {
    // 바이너리는 정규화 대상이 아니며, 여기까지 왔다면 원본이 다른 것이다.
    return false;
  }
  const ext = path.extname(leftPath).slice(1).toLowerCase();
  return (
    normalizeContent(leftBuf.toString('utf8'), ext, options) ===
    normalizeContent(rightBuf.toString('utf8'), ext, options)
  );
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

function normalizeContent(
  text: string,
  ext: string,
  options: CompareOptions
): string {
  if (!options.includeComments) {
    text = stripComments(text, ext);
  }
  if (!options.includeWhitespace) {
    text = text.replace(/\s+/g, '');
  }
  return text;
}

interface CommentSyntax {
  line: string[];
  block: [string, string][];
  strings: string[];
  escape: boolean; // 문자열 안에서 백슬래시 이스케이프를 지원하는 언어인지
}

const C_LIKE: CommentSyntax = {
  line: ['//'],
  block: [['/*', '*/']],
  strings: ['"', "'", '`'],
  escape: true,
};
const HASH_LINE: CommentSyntax = {
  line: ['#'],
  block: [],
  strings: ['"', "'"],
  escape: true,
};
const PYTHON: CommentSyntax = {
  line: ['#'],
  block: [],
  // 삼중따옴표(docstring)는 문자열이므로 주석으로 제거하지 않는다.
  strings: ['"""', "'''", '"', "'"],
  escape: true,
};
const XML_LIKE: CommentSyntax = {
  line: [],
  block: [['<!--', '-->']],
  strings: [],
  escape: false,
};
const SQL: CommentSyntax = {
  line: ['--'],
  block: [['/*', '*/']],
  strings: ["'", '"'],
  escape: false,
};
const LUA: CommentSyntax = {
  line: ['--'],
  block: [['--[[', ']]']],
  strings: ['"', "'"],
  escape: true,
};
const CSS_LIKE: CommentSyntax = {
  line: [],
  block: [['/*', '*/']],
  strings: ['"', "'"],
  escape: true,
};
const MATLAB: CommentSyntax = {
  line: ['%'],
  block: [['%{', '%}']],
  strings: ["'", '"'],
  escape: false,
};

const COMMENT_SYNTAX: Record<string, CommentSyntax> = {
  js: C_LIKE, jsx: C_LIKE, ts: C_LIKE, tsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE,
  java: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, cc: C_LIKE, cxx: C_LIKE,
  hpp: C_LIKE, hh: C_LIKE, cs: C_LIKE, go: C_LIKE, rs: C_LIKE, swift: C_LIKE,
  kt: C_LIKE, kts: C_LIKE, scala: C_LIKE, dart: C_LIKE, groovy: C_LIKE,
  php: C_LIKE, mm: C_LIKE, jsonc: C_LIKE, scss: C_LIKE, less: C_LIKE,
  py: PYTHON, pyw: PYTHON,
  sh: HASH_LINE, bash: HASH_LINE, zsh: HASH_LINE, fish: HASH_LINE,
  rb: HASH_LINE, pl: HASH_LINE, r: HASH_LINE, tcl: HASH_LINE,
  yaml: HASH_LINE, yml: HASH_LINE, toml: HASH_LINE, cmake: HASH_LINE,
  mk: HASH_LINE, makefile: HASH_LINE,
  html: XML_LIKE, htm: XML_LIKE, xml: XML_LIKE, svg: XML_LIKE,
  md: XML_LIKE, markdown: XML_LIKE,
  sql: SQL,
  lua: LUA,
  css: CSS_LIKE,
  m: MATLAB,
};

// 한 줄 주석(줄 끝의 inline 주석 포함)과 멀티라인(블록) 주석을 제거한다.
// 문자열 리터럴 내부의 주석 기호는 주석으로 취급하지 않는다.
function stripComments(text: string, ext: string): string {
  const syntax = COMMENT_SYNTAX[ext];
  if (!syntax) {
    return text;
  }
  let out = '';
  let i = 0;
  const n = text.length;
  outer: while (i < n) {
    for (const quote of syntax.strings) {
      if (text.startsWith(quote, i)) {
        out += quote;
        i += quote.length;
        while (i < n) {
          if (syntax.escape && text[i] === '\\') {
            out += text.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (text.startsWith(quote, i)) {
            out += quote;
            i += quote.length;
            continue outer;
          }
          out += text[i];
          i++;
        }
        continue outer;
      }
    }
    for (const [open, close] of syntax.block) {
      if (text.startsWith(open, i)) {
        const end = text.indexOf(close, i + open.length);
        const segment =
          end === -1 ? text.slice(i) : text.slice(i, end + close.length);
        // 줄 구조가 유지되도록 주석 안의 개행은 남기고, 한 줄짜리 블록 주석은
        // 앞뒤 토큰이 붙지 않게 공백 하나로 대체한다.
        const newlines = segment.replace(/[^\n]+/g, '');
        out += newlines.length > 0 ? newlines : ' ';
        i = end === -1 ? n : end + close.length;
        continue outer;
      }
    }
    for (const marker of syntax.line) {
      if (text.startsWith(marker, i)) {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? n : nl; // 개행 문자는 유지
        continue outer;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sortNodes(nodes: DiffNode[]): DiffNode[] {
  return nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
