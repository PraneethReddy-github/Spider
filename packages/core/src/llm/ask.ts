import { GRAPH_TOOLS, type ToolContext, runGraphTool } from './tools.js';
import type { LlmBlock, LlmMessage, LlmProvider } from './types.js';

/** Streamed to the client while Ask Spider works (C-24). */
export type AskEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; nodeIds: string[]; isError?: boolean }
  | { type: 'done'; answer: string; citations: string[]; seen: string[]; model: string }
  | { type: 'error'; message: string };

/** A prior turn, as the web app keeps it (plain text both ways). */
export interface AskTurn {
  question: string;
  answer: string;
}

export interface AskOptions extends ToolContext {
  provider: LlmProvider;
  repoName: string;
  question: string;
  history?: AskTurn[];
  onEvent?: (e: AskEvent) => void;
  signal?: AbortSignal;
  /** Model turns before giving up (each may call several tools). */
  maxSteps?: number;
}

const system = (repo: string) => `You answer questions about the codebase "${repo}" using a pre-built code graph.
The graph's nodes are directories, files, classes, functions, endpoints, subsystems, datastores and externals; its
edges are imports, calls, inheritance, references, endpoint exposure and datastore reads/writes. Use the tools to look
things up; do not guess structure you have not seen in a tool result. Start with search or subsystems, then follow
relationships. Read source only when structure is not enough.

Cite every node you rely on with a Markdown link whose target is node:<id>, e.g. [UserService](node:Ab3dE5fG7hJ9kL1m).
Use only ids that appeared in tool results. If the graph cannot answer the question, say so and say what is missing.
Answer in concise Markdown: lead with the answer, then the evidence.`;

const CITE = /\(node:([A-Za-z0-9_-]+)\)/g;

/** Runs the tool loop until the model answers; every claim is meant to cite node ids from tool results. */
export async function ask(o: AskOptions): Promise<{ answer: string; citations: string[]; seen: string[] }> {
  const emit = o.onEvent ?? (() => {});
  const messages: LlmMessage[] = [];
  for (const t of o.history ?? []) {
    messages.push({ role: 'user', content: [{ type: 'text', text: t.question }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: t.answer }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: o.question }] });
  const seen = new Set<string>();
  let answer = '';
  let model = o.provider.model;
  for (let step = 0; step < (o.maxSteps ?? 12); step++) {
    const r = await o.provider.chat({
      system: system(o.repoName),
      messages,
      tools: GRAPH_TOOLS,
      effort: 'medium',
      signal: o.signal,
      onText: (delta) => {
        answer += delta;
        emit({ type: 'text', delta });
      },
    });
    model = r.model;
    if (r.stop === 'refusal') throw new Error('The model declined to answer this question.');
    const calls = r.content.filter((b): b is Extract<LlmBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    // only a clean tool_use stop runs tools: an input cut off at max_tokens never does
    if (r.stop !== 'tool_use' || calls.length === 0) {
      if (r.stop === 'max_tokens') answer += '\n\n_(answer cut off at the output limit)_';
      return finish();
    }
    messages.push({ role: 'assistant', content: r.content, raw: r.raw });
    const results: LlmBlock[] = [];
    for (const c of calls) {
      emit({ type: 'tool', name: c.name, input: c.input });
      const out = await runGraphTool(o, c.name, c.input);
      for (const id of out.nodeIds) seen.add(id);
      emit({ type: 'tool_result', name: c.name, nodeIds: out.nodeIds, isError: out.isError });
      results.push({ type: 'tool_result', toolUseId: c.id, content: out.text, isError: out.isError });
    }
    messages.push({ role: 'user', content: results });
    // text written before tool calls is narration, not the answer (clients reset on the next `tool` event)
    answer = '';
  }
  throw new Error(`No answer after ${o.maxSteps ?? 12} steps; try a narrower question.`);

  function finish() {
    answer = answer.trim();
    // keep only citations of real nodes the tools returned (a model can invent ids)
    const citations = [...new Set([...answer.matchAll(CITE)].map((m) => m[1]))].filter(
      (id) => seen.has(id) && !!o.q.node(id),
    );
    emit({ type: 'done', answer, citations, seen: [...seen], model });
    return { answer, citations, seen: [...seen] };
  }
}
