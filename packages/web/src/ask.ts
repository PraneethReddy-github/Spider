import { create } from 'zustand';

/** Ask Spider (C-24): the panel's conversation. Events mirror `AskEvent` in @spider/core. */
export type AskEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; nodeIds: string[]; isError?: boolean }
  | { type: 'done'; answer: string; citations: string[]; seen: string[]; model: string }
  | { type: 'error'; message: string };

export interface AskEntry {
  question: string;
  /** Streamed text so far, replaced by the final answer on `done`. */
  answer: string;
  steps: string[];
  citations: string[];
  status: 'running' | 'done' | 'error';
  error?: string;
  model?: string;
}

interface AskState {
  open: boolean;
  entries: AskEntry[];
  setOpen: (open: boolean) => void;
  push: (e: AskEntry) => void;
  update: (fn: (e: AskEntry) => AskEntry) => void;
  clear: () => void;
}

export const useAsk = create<AskState>((set) => ({
  open: false,
  entries: [],
  setOpen: (open) => set({ open }),
  push: (e) => set((s) => ({ entries: [...s.entries, e] })),
  update: (fn) => set((s) => ({ entries: [...s.entries.slice(0, -1), fn(s.entries[s.entries.length - 1])] })),
  clear: () => set({ entries: [] }),
}));

const STEP_LABEL: Record<string, string> = {
  search: 'Searching',
  node_detail: 'Reading node',
  upstream: 'Following dependents',
  downstream: 'Following dependencies',
  path: 'Finding a path',
  endpoints: 'Listing endpoints',
  trace: 'Tracing an endpoint',
  subsystems: 'Reading subsystems',
  diagnostics: 'Reading diagnostics',
  source: 'Reading source',
};

export const stepLabel = (name: string, input: unknown) => {
  const q = (input as { query?: string })?.query;
  return `${STEP_LABEL[name] ?? name}${q ? ` “${q}”` : ''}`;
};

/** POSTs the question and feeds server-sent events to `onEvent` until the stream ends. */
export async function streamAsk(
  repoId: string,
  body: { question: string; history: { question: string; answer: string }[] },
  onEvent: (e: AskEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/v1/repos/${encodeURIComponent(repoId)}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i = buf.indexOf('\n\n');
    while (i >= 0) {
      const data = buf
        .slice(0, i)
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      buf = buf.slice(i + 2);
      if (data) onEvent(JSON.parse(data) as AskEvent);
      i = buf.indexOf('\n\n');
    }
  }
}
