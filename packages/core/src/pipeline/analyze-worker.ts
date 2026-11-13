// Worker-thread entry for `analyzeInWorker`: runs the whole pipeline (incl. resolve/enrich/persist, which are
// synchronous) off the caller's event loop and streams progress back.
import { parentPort, workerData } from 'node:worker_threads';
import { type AnalyzeOptions, analyze } from '../analyze.js';

const port = parentPort;
if (!port) throw new Error('analyze-worker must run in a worker thread');

analyze({ ...(workerData as Omit<AnalyzeOptions, 'onProgress'>), onProgress: (e) => port.postMessage({ progress: e }) })
  .then((info) => port.postMessage({ info }))
  .catch((err: unknown) => port.postMessage({ error: err instanceof Error ? err.message : String(err) }));
