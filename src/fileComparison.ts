import { Worker } from 'node:worker_threads';
import { CompareOptions } from './compare';
import { DiffRow } from './fileDiff';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_LINES = 200000;

export interface RenderRow {
  left?: { number: number };
  right?: { number: number };
  changed: boolean;
  leftChanges?: DiffRow['leftChanges'];
  rightChanges?: DiffRow['rightChanges'];
}

/** Source text lives in Monaco models; send only alignment and highlighting data. */
export function compactRows(rows: DiffRow[]): RenderRow[] {
  return rows.map(row => ({
    left: row.left ? { number: row.left.number } : undefined,
    right: row.right ? { number: row.right.number } : undefined,
    changed: row.changed, leftChanges: row.leftChanges, rightChanges: row.rightChanges,
  }));
}

export function startFileComparison(workerPath: string, texts: string[], ext: string, options: CompareOptions,
  onProgress: (completed: number, total: number) => void): { result: Promise<RenderRow[]>; cancel: () => void } {
  const worker = new Worker(workerPath, { workerData: { texts, ext, options } });
  let cancel!: () => void;
  const result = new Promise<RenderRow[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, rows?: RenderRow[]) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      if (error) reject(error);
      else resolve(rows!);
    };
    cancel = () => finish(new Error('Comparison superseded'));
    worker.on('message', message => {
      if (settled) return;
      if (message.type === 'result') finish(undefined, message.rows);
      else if (message.type === 'error') finish(new Error(message.message));
      else if (message.type === 'progress') {
        try { onProgress(message.completed, message.total); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`File comparison worker exited (${code})`)); });
  });
  return { result, cancel };
}
