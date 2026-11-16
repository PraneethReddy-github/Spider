import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { type AskEntry, stepLabel, streamAsk, useAsk } from '../ask';
import { useReveal, useRevealMany } from '../hooks';
import { useStore } from '../store';
import { IconButton, Spinner } from '../ui';
import './AskPanel.css';

/** Ask Spider (C-24): questions answered from the graph; cited nodes link to (and reveal on) the map. */
export function AskPanel({ repoId }: { repoId: string }) {
  const { open, entries, setOpen, push, update, clear } = useAsk();
  const llm = useQuery({ queryKey: ['llm'], queryFn: api.llm, staleTime: 5 * 60_000, enabled: open });
  const [question, setQuestion] = useState('');
  const abort = useRef<AbortController>();
  const end = useRef<HTMLDivElement>(null);
  const revealMany = useRevealMany();
  const running = entries.at(-1)?.status === 'running';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  // leaving the repo stops a running answer and forgets the conversation
  useEffect(
    () => () => {
      abort.current?.abort();
      clear();
      setOpen(false);
    },
    [clear, setOpen],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new entry or streamed chunk
  useEffect(() => {
    // braces matter: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup
    end.current?.scrollIntoView({ block: 'end' });
  }, [entries]);

  if (!open) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || running) return;
    const history = entries
      .filter((x) => x.status === 'done')
      .slice(-6)
      .map((x) => ({ question: x.question, answer: x.answer }));
    push({ question: q, answer: '', steps: [], citations: [], status: 'running' });
    setQuestion('');
    const ac = new AbortController();
    abort.current = ac;
    streamAsk(
      repoId,
      { question: q, history },
      (ev) =>
        update((x) => {
          if (ev.type === 'text') return { ...x, answer: x.answer + ev.delta };
          // text before a tool call was narration: drop it
          if (ev.type === 'tool') return { ...x, answer: '', steps: [...x.steps, stepLabel(ev.name, ev.input)] };
          if (ev.type === 'done') {
            if (ev.citations.length) void revealMany(ev.citations);
            return { ...x, answer: ev.answer, citations: ev.citations, status: 'done', model: ev.model };
          }
          if (ev.type === 'error') return { ...x, status: 'error', error: ev.message };
          return x;
        }),
      ac.signal,
    )
      .then(() =>
        update((x) => (x.status === 'running' ? { ...x, status: 'error', error: 'The answer stopped early.' } : x)),
      )
      .catch((err) => {
        if (!ac.signal.aborted) update((x) => ({ ...x, status: 'error', error: String(err.message ?? err) }));
      });
  };

  const stop = () => {
    abort.current?.abort();
    update((x) => ({ ...x, status: 'error', error: 'Stopped.' }));
  };

  const off = llm.data && !llm.data.provider;
  return (
    <section className="overlay ask-panel" aria-label="Ask Spider">
      <header className="panel-header">
        <h2>Ask Spider</h2>
        {entries.length > 0 && !running && (
          <button type="button" className="btn btn-ghost" onClick={clear}>
            Clear
          </button>
        )}
        <IconButton label="Close Ask Spider" onClick={() => setOpen(false)}>
          <X size={16} strokeWidth={1.5} />
        </IconButton>
      </header>
      <div className="ask-body">
        {off && (
          <p className="tone-3">
            No model is configured. Set <code>SPIDER_LLM_PROVIDER</code> (anthropic, openai or ollama) and restart{' '}
            <code>spider serve</code>. Nothing is sent anywhere until you do.
          </p>
        )}
        {!off && entries.length === 0 && (
          <p className="tone-3">
            Ask about this codebase: where something lives, what depends on what, how a request flows. Answers cite
            nodes; click one to show it on the map.
          </p>
        )}
        {entries.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries only append
          <Entry key={i} entry={x} />
        ))}
        <div ref={end} />
      </div>
      <form className="ask-form" onSubmit={submit}>
        <textarea
          className="input"
          rows={2}
          placeholder={running ? 'Answering…' : 'Ask a question'}
          aria-label="Question"
          value={question}
          disabled={!!off}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
          }}
        />
        {running ? (
          <button type="button" className="btn btn-secondary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!question.trim() || !!off}>
            Ask
          </button>
        )}
      </form>
    </section>
  );
}

function Entry({ entry: x }: { entry: AskEntry }) {
  return (
    <article className="ask-entry">
      <p className="ask-question">{x.question}</p>
      {x.steps.length > 0 && (
        <ol className="ask-steps t-caption tone-3">
          {x.steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps only append
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {x.answer && <Markdown text={x.answer} citations={x.citations} final={x.status === 'done'} />}
      {x.status === 'running' && <Spinner label="Answering" />}
      {x.status === 'error' && <p className="tone-3">{x.error}</p>}
      {x.model && <p className="t-caption tone-3">{x.model}</p>}
    </article>
  );
}

/**
 * Just enough Markdown for answers: paragraphs, `-`/`1.` lists, headings as bold lines, `code`, **bold**, and
 * links. `node:<id>` links become buttons only when the server confirmed the citation.
 */
function Markdown({ text, citations, final }: { text: string; citations: string[]; final: boolean }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="ask-answer">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        const key = `${i}:${b.slice(0, 16)}`;
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l)))
          return (
            <ul key={key}>
              {lines.map((l, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static text
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''), citations, final)}</li>
              ))}
            </ul>
          );
        if (/^```/.test(b)) return <pre key={key}>{b.replace(/^```\w*\n?|```$/g, '')}</pre>;
        return <p key={key}>{inline(b.replace(/^#+\s*/, ''), citations, final)}</p>;
      })}
    </div>
  );
}

function inline(s: string, citations: string[], final: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = m.index;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[4].startsWith('node:')) {
      const id = m[4].slice(5);
      out.push(final && citations.includes(id) ? <Cite key={k} id={id} label={m[3]} /> : m[3]);
    } else out.push(m[3]);
    last = k + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Cite({ id, label }: { id: string; label: string }) {
  const reveal = useReveal();
  const setHovered = useStore((s) => s.setHovered);
  return (
    <button
      type="button"
      className="ask-cite"
      onClick={() => void reveal(id)}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(undefined)}
      onFocus={() => setHovered(id)}
      onBlur={() => setHovered(undefined)}
    >
      {label}
    </button>
  );
}
