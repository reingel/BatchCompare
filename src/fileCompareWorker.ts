import { parentPort, workerData } from 'node:worker_threads';
import { compareFileTextAsync } from './fileDiff';
import { compactRows } from './fileComparison';

void (async () => {
  try {
    const { texts, ext, options } = workerData;
    let lastUpdate = 0;
    const rows = await compareFileTextAsync(texts[0], texts[1], ext, options, (completed, total) => {
      const now = Date.now();
      if (completed === 0 || completed === total || now - lastUpdate >= 50) {
        parentPort!.postMessage({ type: 'progress', completed, total });
        lastUpdate = now;
      }
    });
    parentPort!.postMessage({ type: 'result', rows: compactRows(rows) });
  } catch (error) {
    parentPort!.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
})();
