import { CompareOptions, stripComments } from './compare';

export interface CompareLine { number: number; text: string; key: string; columns?: number[] }
export interface ColumnRange { startColumn: number; endColumn: number }
export interface DiffRow { left?: CompareLine; right?: CompareLine; changed: boolean;
  leftChanges?: ColumnRange[]; rightChanges?: ColumnRange[] }

/** Keep original line numbers even when comment-only/whitespace-only lines disappear. */
export function projectLines(text: string, ext: string, options: CompareOptions): CompareLine[] {
  text = text.replace(/\r\n?/g, '\n');
  const original = text.split('\n');
  const offsets: number[] = [];
  const filtered = (options.includeComments ? text : stripComments(text, ext, offsets)).split('\n');
  let sourceStart = 0, filteredStart = 0;
  return filtered.flatMap((value, i) => {
    const origin = sourceStart, start = filteredStart;
    sourceStart += original[i].length + 1;
    filteredStart += value.length + 1;
    const commentRemoved = !options.includeComments && value !== original[i];
    if (commentRemoved && !value.trim()) return [];
    // The empty split item after a final comment's newline belongs to that comment.
    if (!options.includeComments && i === filtered.length - 1 && !value && i > 0 &&
      filtered[i - 1] !== original[i - 1] && !filtered[i - 1].trim()) return [];
    const display = commentRemoved ? value.trimEnd() : value;
    const key = options.includeWhitespace ? display : display.replace(/\s+/g, '');
    if (!options.includeWhitespace && !key) return [];
    const columns: number[] = [];
    for (let j = 0; j < display.length; j++) {
      if (!options.includeWhitespace && /\s/.test(display[j])) continue;
      const offset = options.includeComments ? origin + j : offsets[start + j];
      columns.push(offset < 0 ? 0 : offset - origin + 1);
    }
    return [{ number: i + 1, text: original[i], key, columns }];
  });
}

/** Reinsert ignored lines as neutral rows: options affect matching, never the source. */
export function compareFileText(left: string, right: string, ext: string, options: CompareOptions): DiffRow[] {
  const raw = [left, right].map(text => text.replace(/\r\n?/g, '\n').split('\n')
    .map((text, i) => ({ number: i + 1, text, key: text })));
  const matched = diffLines(projectLines(left, ext, options), projectLines(right, ext, options));
  const rows: DiffRow[] = [];
  let l = 0, r = 0;
  const gap = (endLeft: number, endRight: number) => {
    while (l < endLeft || r < endRight) rows.push({
      left: l < endLeft ? raw[0][l++] : undefined,
      right: r < endRight ? raw[1][r++] : undefined, changed: false,
    });
  };
  for (const row of matched) {
    gap(row.left ? row.left.number - 1 : l, row.right ? row.right.number - 1 : r);
    if (row.changed) addInlineChanges(row);
    if (row.left) delete row.left.columns;
    if (row.right) delete row.right.columns;
    rows.push(row);
    if (row.left) l++;
    if (row.right) r++;
  }
  gap(raw[0].length, raw[1].length);
  return rows;
}

/** Compare normalized characters, then map changes back to original UTF-16 columns. */
function addInlineChanges(row: DiffRow): void {
  const characters = (line?: CompareLine): CompareLine[] => {
    let offset = 1;
    return Array.from(line?.key ?? '', char => {
      const unit = { number: offset, text: char, key: char };
      offset += char.length;
      return unit;
    });
  };
  const left = characters(row.left), right = characters(row.right);
  // Trim common ends before Myers so large, nearly-identical lines stay inexpensive.
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start].key === right[start].key) start++;
  while (end < left.length - start && end < right.length - start &&
    left[left.length - end - 1].key === right[right.length - end - 1].key) end++;
  const edits = diffLines(left.slice(start, left.length - end), right.slice(start, right.length - end), 10000);
  const ranges = (side: 'left' | 'right'): ColumnRange[] => {
    const line = row[side];
    const result: ColumnRange[] = [];
    for (const edit of edits) {
      const char = edit[side];
      if (!edit.changed || !char || !line) continue;
      for (let i = 0; i < char.text.length; i++) {
        const index = char.number - 1 + i;
        const column = line.columns?.[index] ?? index + 1;
        if (column <= 0) continue; // Synthetic token separator replacing a comment.
        const previous = result[result.length - 1];
        if (previous && previous.endColumn === column) previous.endColumn++;
        else result.push({ startColumn: column, endColumn: column + 1 });
      }
    }
    return result;
  };
  row.leftChanges = ranges('left'); row.rightChanges = ranges('right');
}

/** Myers line diff, with a work budget for completely different large files. */
export function diffLines(left: CompareLine[], right: CompareLine[], maxWork = 250000): DiffRow[] {
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);
  let work = 0;
  for (let d = 0; d <= left.length + right.length; d++) {
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      if (++work > maxWork) return pairChanges(left, right);
      let x = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
        ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < left.length && y < right.length && left[x].key === right[y].key) { x++; y++; }
      frontier.set(k, x);
      if (x >= left.length && y >= right.length) {
        const edits: DiffRow[] = [];
        for (let depth = d; depth >= 0; depth--) {
          const previous = trace[depth];
          const diagonal = x - y;
          const previousK = diagonal === -depth || (diagonal !== depth &&
            (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
            ? diagonal + 1 : diagonal - 1;
          const previousX = previous.get(previousK) ?? 0;
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            edits.push({ left: left[--x], right: right[--y], changed: false });
          }
          if (depth > 0) {
            if (x === previousX) edits.push({ right: right[--y], changed: true });
            else edits.push({ left: left[--x], changed: true });
          }
        }
        edits.reverse();
        const rows: DiffRow[] = [];
        for (let i = 0; i < edits.length;) {
          if (!edits[i].changed) { rows.push(edits[i++]); continue; }
          const removed: CompareLine[] = [], added: CompareLine[] = [];
          while (i < edits.length && edits[i].changed) {
            if (edits[i].left) removed.push(edits[i].left!);
            if (edits[i].right) added.push(edits[i].right!);
            i++;
          }
          for (const row of pairChanges(removed, added)) rows.push(row);
        }
        return rows;
      }
    }
  }
  return [];
}

function pairChanges(left: CompareLine[], right: CompareLine[]): DiffRow[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => ({
    left: left[i], right: right[i], changed: true,
  }));
}
