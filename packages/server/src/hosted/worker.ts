import { analyze } from '@spider/core';
import pg from 'pg';
import { JOBS_CHANNEL, REPO_CHANNEL, openDb } from './db.js';

export interface WorkerOptions {
  databaseUrl: string;
  home?: string;
  /** Stop after this many jobs (tests); default: run until `signal` aborts. */
  maxJobs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/**
 * Drains the hosted job queue (S-4): claims the oldest queued job with `FOR UPDATE SKIP LOCKED` (so any number of
 * workers can run), analyses it into the shared `SPIDER_HOME`, records progress, and notifies the servers. A job
 * whose worker stopped sending heartbeats for 2 minutes is claimed again.
 */
export async function runWorker(o: WorkerOptions): Promise<number> {
  const db = await openDb(o.databaseUrl);
  const log = o.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const wake = new pg.Client({ connectionString: o.databaseUrl });
  await wake.connect();
  await wake.query(`listen ${JOBS_CHANNEL}`);
  let poke: () => void = () => {};
  wake.on('notification', () => poke());
  o.signal?.addEventListener('abort', () => poke());
  let done = 0;
  try {
    while (!o.signal?.aborted && (o.maxJobs === undefined || done < o.maxJobs)) {
      const claimed = await db.query(
        `update jobs set status = 'running', started_at = now(), heartbeat = now()
          where id = (
            select id from jobs
             where status = 'queued' or (status = 'running' and heartbeat < now() - interval '2 minutes')
             order by created_at
             for update skip locked
             limit 1)
          returning *`,
      );
      const job = claimed.rows[0];
      if (!job) {
        // sleep until a NOTIFY or 5 s (covers a missed notification)
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000);
          poke = () => {
            clearTimeout(t);
            resolve();
          };
        });
        continue;
      }
      log(`job ${job.id}: ${job.source}`);
      const lines: string[] = [];
      let last = 0;
      let pending: Promise<unknown> = Promise.resolve();
      try {
        const info = await analyze({
          source: job.source,
          ref: job.ref ?? undefined,
          name: job.name ?? undefined,
          repoId: job.repo_id,
          home: o.home,
          onProgress: (e) => {
            if (e.message && (e.stage !== 'parse' || e.current === e.total)) lines.push(`[${e.stage}] ${e.message}`);
            const now = Date.now();
            if (now - last < 250 && e.current !== e.total) return;
            last = now;
            pending = pending.then(() =>
              db.query(
                `update jobs set stage = $2, current = $3, total = $4, message = $5, log = $6, heartbeat = now()
                  where id = $1`,
                [job.id, e.stage, e.current, e.total, e.message ?? null, JSON.stringify(lines.slice(-200))],
              ),
            );
          },
        });
        await pending;
        await db.query('update repos set info = $2, name = $3 where repo_id = $1', [job.repo_id, info, info.name]);
        await db.query(
          `update jobs set status = 'done', log = $2, finished_at = now(), heartbeat = now() where id = $1`,
          [job.id, JSON.stringify(lines.slice(-200))],
        );
        await db.query(`select pg_notify('${REPO_CHANNEL}', $1)`, [job.repo_id]);
        log(`job ${job.id}: done (${info.stats.nodes} nodes)`);
      } catch (err) {
        await pending.catch(() => {});
        const msg = String((err as Error)?.message ?? err);
        await db.query(`update jobs set status = 'failed', error = $2, finished_at = now() where id = $1`, [
          job.id,
          msg,
        ]);
        log(`job ${job.id}: failed: ${msg}`);
      }
      done++;
    }
  } finally {
    await wake.end().catch(() => {});
    await db.end().catch(() => {});
  }
  return done;
}
