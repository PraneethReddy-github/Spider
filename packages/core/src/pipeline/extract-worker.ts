// Worker-thread entry for the parse+extract pool (see extract.ts). Receives batches of ExtractJob and replies
// with one JSON string of FileFacts per job, in order — JSON so results match the on-disk cache form exactly.
import { parentPort, workerData } from 'node:worker_threads';
import { type ExtractJob, extractFile } from './extract-file.js';

const port = parentPort;
if (!port) throw new Error('extract-worker must run in a worker thread');
const frameworks = new Set<string>((workerData as { frameworks: string[] }).frameworks);

port.on('message', async (jobs: ExtractJob[]) => {
  const out: string[] = [];
  for (const job of jobs) out.push(JSON.stringify(await extractFile(job, frameworks)));
  port.postMessage(out);
});
