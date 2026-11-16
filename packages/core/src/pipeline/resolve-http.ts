import type { GraphBuilder } from '../graph/builder.js';
import type { CallFact, FileFacts } from '../languages/types.js';
import { type FileTable, findBinding, nearestOwner } from './resolve.js';

/**
 * C-19 polyglot HTTP linking: HTTP client calls (fetch, axios, ky/got/superagent, requests/httpx/aiohttp,
 * Go net/http, reqwest, RestTemplate/WebClient, HttpClient) whose path is a literal or template string are
 * matched against every endpoint in the graph, whatever its language, and become `calls` edges from the
 * calling symbol to the endpoint (`props.protocol = 'http'`).
 *
 * Confidence: 1 = literal path, exact method, endpoint without params; 0.8 = template / param match or
 * unknown method; ≤ 0.5 + `ambiguous` when several endpoints match equally well.
 */

const HTTP_LIBS = new Set([
  'axios',
  'ky',
  'got',
  'superagent',
  'node-fetch',
  'cross-fetch',
  'ofetch',
  'undici',
  'requests',
  'httpx',
  'aiohttp',
  'reqwest',
  'net/http',
]);
/** Typed receivers that are HTTP clients regardless of imports (Angular, Spring, .NET, NestJS, test clients). */
const CLIENT_TYPES = new Set([
  'HttpClient',
  'RestTemplate',
  'TestRestTemplate',
  'RestClient',
  'WebClient',
  'AxiosInstance',
  'HttpService',
  'TestClient',
]);
/** Untyped receivers trusted only in files that import an HTTP library (`with httpx.Client() as client`). */
const CLIENT_NAMES = new Set(['client', 'session', 'http', 'api', 'httpClient', 'apiClient', 'ac']);
const GLOBAL_FETCH = new Set(['fetch', 'window.fetch', 'globalThis.fetch', '$fetch', 'ofetch']);
/** `get`, `GetAsync`, `postForEntity` — not `headers` or `getaway`. */
const VERB = /^([Gg]et|[Pp]ost|[Pp]ut|[Pp]atch|[Dd]elete|[Hh]ead|[Oo]ptions)(?![a-z])/;
const METHOD_REF = /(?:Method|\.)(Get|Post|Put|Patch|Delete|Head|Options)$/i;
const VERB_ONLY = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
/** Generic request functions whose method comes from an argument or option. */
const REQUEST_FNS = new Set([
  'request',
  'exchange',
  'fetch',
  'newrequest',
  'newrequestwithcontext',
  'send',
  'do',
  'method',
]);

interface EndpointIx {
  id: string;
  method: string;
  segs: (string | null)[];
  catchAll: boolean;
  isTest: boolean;
}

interface HttpCall {
  method?: string;
  segs: (string | null)[];
  literal: boolean;
  /** Heuristic receiver (untyped name): never above 0.8. */
  weak: boolean;
}

export function resolveHttp(g: GraphBuilder, tables: Iterable<FileTable>): void {
  const endpoints = indexEndpoints(g);
  if (endpoints.length === 0) return;
  for (const table of tables) {
    const libs = libLocals(table.facts);
    const isTestFile = !!g.getNode(table.fileId)?.props.isTest;
    for (const call of table.facts.calls) {
      const hc = httpCall(table, call, libs);
      if (!hc) continue;
      const links = match(hc, endpoints, isTestFile);
      const callerId = callerOf(table, call.callerQname);
      for (const l of links)
        g.addEdge('calls', callerId, l.id, {
          confidence: l.confidence,
          evidence: call.span,
          props: { protocol: 'http', ...(l.confidence < 1 && links.length > 1 ? { ambiguous: true } : {}) },
        });
    }
  }
}

/** The symbol a call is made from (nearest declared ancestor), else the file. */
export function callerOf(table: FileTable, qname: string | undefined): string {
  return qname ? (table.own.get(qname)?.id ?? nearestOwner(table, qname)) : table.fileId;
}

/* ---------- endpoints ---------- */

function indexEndpoints(g: GraphBuilder): EndpointIx[] {
  const out: EndpointIx[] = [];
  for (const n of g.nodesOfKind('endpoint')) {
    const method = String(n.props.method ?? 'ANY');
    if (method === 'WS' || method === 'USE') continue;
    const raw = String(n.props.path ?? '');
    if (raw.startsWith('grpc:') || !raw.startsWith('/')) continue;
    const parts = raw.split('?')[0].split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    const catchAll = /^(\*|\{\*|\[\.\.\.|\[\[\.\.\.|<path:)|:path\}$/.test(last);
    out.push({
      id: n.id,
      method: method.toUpperCase(),
      segs: (catchAll ? parts.slice(0, -1) : parts).map((s) => (/^[:*]|^\{.*\}$|^<.*>$|^\[.*\]$/.test(s) ? null : s)),
      catchAll,
      isTest: !!n.props.isTest,
    });
  }
  return out;
}

/* ---------- client calls ---------- */

/** Local names bound to an HTTP library by the file's imports. */
function libLocals(facts: FileFacts): Set<string> {
  const out = new Set<string>();
  for (const imp of facts.imports) {
    const spec = imp.specifier;
    const root = spec === 'net/http' ? spec : spec.split(/::|[/.]/)[0];
    if (!HTTP_LIBS.has(root)) continue;
    if (imp.namespace) out.add(imp.namespace);
    for (const n of imp.names) if (n.local !== '*') out.add(n.local);
    if (spec === 'net/http' && !imp.namespace) out.add('http');
  }
  return out;
}

function httpCall(table: FileTable, call: CallFact, libs: Set<string>): HttpCall | undefined {
  if (!call.args && !call.kw) return undefined;
  const callee = call.callee.replace(/::/g, '.');
  const segs = callee.split('.');
  const last = segs[segs.length - 1];
  const receiver = segs.slice(0, -1).join('.');
  let weak = false;
  let base: string | undefined;
  const isJs = table.facts.language === 'typescript' || table.facts.language === 'javascript';
  if (isJs && GLOBAL_FETCH.has(callee)) {
    // fetch(url, { method })
  } else if (libs.has(segs[0]) && (table.facts.language === 'go' ? isGoHttp(segs) : segs.length <= 2)) {
    // axios(cfg) · axios.get(url) · requests.post(url) · http.Get(url) · reqwest.get(url)
  } else if (receiver) {
    // `mux.HandleFunc("/x", h)` on a net/http value, `api.authorize(http.MethodGet, "/x")`: not requests
    if (!VERB.test(last) && !REQUEST_FNS.has(last.toLowerCase().replace(/async$/, ''))) return undefined;
    const client = clientOf(table, receiver, call.callerQname, libs);
    if (!client) {
      if (libs.size === 0 || !CLIENT_NAMES.has(segs[segs.length - 2] ?? '')) return undefined;
      weak = true;
    } else base = client.base;
  } else return undefined;

  const args = call.args ?? [];
  const isMethodArg = (a: (typeof args)[number]) =>
    !!a && (a.s !== undefined ? VERB_ONLY.test(a.s) : METHOD_REF.test(a.r ?? ''));
  let method = VERB.test(last) && !REQUEST_FNS.has(last.toLowerCase()) ? VERB.exec(last)?.[1].toUpperCase() : undefined;
  if (!method && call.kw?.method) method = call.kw.method.toUpperCase();
  const m = args.find(isMethodArg);
  if (!method && m) method = (m.s ?? METHOD_REF.exec(m.r ?? '')?.[1])?.toUpperCase();
  if (!method && isJs && GLOBAL_FETCH.has(callee)) method = 'GET';
  if (method && !VERB_ONLY.test(method)) return undefined;
  // the URL is the first argument, after a method argument (`NewRequest(http.MethodPost, url)`) or a context
  const i = args.findIndex((a) => a?.s !== undefined && !isMethodArg(a));
  const pre = args.slice(0, Math.max(0, i));
  const urlFirst = i >= 0 && pre.every((a, k) => isMethodArg(a) || (k === 0 && last === 'NewRequestWithContext'));
  const raw = urlFirst ? args[i]?.s : call.kw?.url;
  if (raw === undefined) return undefined;
  const path = normalisePath(raw, base ?? call.kw?.baseURL);
  return path ? { method, ...path, weak } : undefined;
}

function isGoHttp(segs: string[]): boolean {
  return segs.length === 2 && /^(Get|Post|Head|PostForm|NewRequest|NewRequestWithContext)$/.test(segs[1]);
}

/**
 * Whether `receiver` is an HTTP client: a binding (local, field or an imported module variable) to an HTTP
 * library call/type or a known client type. `base` is the axios instance's `baseURL` when one is set.
 */
function clientOf(
  table: FileTable,
  receiver: string,
  scope: string | undefined,
  libs: Set<string>,
): { base?: string } | undefined {
  let owner = table;
  let ownLibs = libs;
  let b = findBinding(table, receiver, scope);
  if (!b && !receiver.includes('.')) {
    // `import { api } from './api'` → the module-level binding in the defining file
    const local = table.locals.get(receiver);
    const def = local?.kind === 'symbol' ? table.ctx.byId.get(local.id) : undefined;
    if (def && !def.entry.decl.parentQname) {
      owner = def.table;
      ownLibs = libLocals(owner.facts);
      b = owner.bindings.get('')?.get(def.entry.decl.name);
    }
  }
  if (!b) return undefined;
  const ref = b.ref.replace(/::/g, '.');
  const head = ref.split('.')[0];
  const type = ref.split('.').pop() ?? '';
  if (!ownLibs.has(head) && !CLIENT_TYPES.has(type) && !(b.isType && CLIENT_TYPES.has(head))) return undefined;
  // axios.create({ baseURL }) / httpx.Client(base_url=…): only when the file creates exactly one instance
  const creates = owner.facts.calls.filter((c) => c.callee === b.ref && (c.kw?.baseURL ?? c.kw?.base_url));
  const base = creates.length === 1 ? (creates[0].kw?.baseURL ?? creates[0].kw?.base_url) : undefined;
  return { base };
}

/* ---------- paths ---------- */

/** Strips scheme + host (local, interpolated or bare service names only) or a leading `${BASE}`. */
function urlPath(raw: string): { p: string; literal: boolean; absolute: boolean } | undefined {
  let p = raw.trim().split(/[?#]/)[0];
  const host = /^[a-z][\w+.-]*:\/\/([^/]*)/i.exec(p);
  if (host) {
    const h = host[1].replace(/:\d+$/, '');
    // public hosts (`api.github.com`) are somebody else's API
    if (!h.includes('{}') && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(h) && h.includes('.')) return undefined;
    p = p.slice(host[0].length);
    return { p: p || '/', literal: !h.includes('{}'), absolute: true };
  }
  if (p.startsWith('{}')) {
    p = p.slice(2); // `${API_BASE}/users`: an environment base URL
    return p === '' || p.startsWith('/') ? { p: p || '/', literal: false, absolute: true } : undefined;
  }
  return { p, literal: true, absolute: false };
}

/**
 * `http://localhost:8000/users/{}?q=1` → segments `users`, param; `base` is an axios/httpx `baseURL`.
 * Relative paths (`api/users`, HttpClient `BaseAddress` style) need a `/` or a base.
 */
export function normalisePath(raw: string, base?: string): { segs: (string | null)[]; literal: boolean } | undefined {
  const u = urlPath(raw);
  if (!u) return undefined;
  let { p, literal } = u;
  if (base !== undefined && !u.absolute) {
    const b = urlPath(base);
    if (!b) return undefined;
    p = `${b.p.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
    literal &&= b.literal;
  }
  if (!p.startsWith('/')) {
    if (!/^[a-z][\w-]*\//i.test(p)) return undefined;
    p = `/${p}`;
  }
  if (!/^\/[\w\-.~%@:{}$/]*$/.test(p) || p.includes('//')) return undefined;
  const segs = p
    .split('/')
    .filter(Boolean)
    .map((s) => (s.includes('{') || s.startsWith(':') ? null : s));
  if (segs.includes(null)) literal = false;
  return { segs, literal };
}

/* ---------- matching ---------- */

function match(hc: HttpCall, endpoints: EndpointIx[], isTestFile: boolean): { id: string; confidence: number }[] {
  let best = scoreAll(hc.segs, hc, endpoints, isTestFile);
  let viaPrefix = false;
  // a dev proxy often serves the backend under /api (or /api/v1) without the backend knowing it
  if (best.length === 0 && hc.segs[0] === 'api') {
    const drop = hc.segs[1] && /^v\d+$/.test(hc.segs[1]) ? 2 : 1;
    best = scoreAll(hc.segs.slice(drop), hc, endpoints, isTestFile);
    viaPrefix = true;
  }
  if (best.length === 0 || best.length > 4) return [];
  if (best.length > 1) return best.map((b) => ({ id: b.ep.id, confidence: Math.min(0.5, 0.8 / best.length) }));
  const { ep, exactMethod } = best[0];
  const exact = hc.literal && exactMethod && !viaPrefix && !hc.weak && !ep.catchAll && !ep.segs.includes(null);
  const confidence = exact ? 1 : 0.8;
  // test code links to production endpoints only on an exact match
  if (isTestFile && confidence < 1) return [];
  return [{ id: ep.id, confidence }];
}

function scoreAll(
  segs: (string | null)[],
  hc: HttpCall,
  endpoints: EndpointIx[],
  isTestFile: boolean,
): { ep: EndpointIx; exactMethod: boolean }[] {
  let top = -1;
  let out: { ep: EndpointIx; exactMethod: boolean }[] = [];
  for (const ep of endpoints) {
    if (ep.isTest && !isTestFile) continue;
    const exactMethod = !!hc.method && ep.method === hc.method;
    if (hc.method && !exactMethod && ep.method !== 'ANY') continue;
    const s = segScore(segs, ep);
    if (s < 0) continue;
    const score = s * 2 + (exactMethod ? 1 : 0);
    if (score > top) {
      top = score;
      out = [];
    }
    if (score === top) out.push({ ep, exactMethod });
  }
  return out;
}

/** −1 = no match; else 2 per literal = literal segment, 1 per segment bound to a path param. */
function segScore(call: (string | null)[], ep: EndpointIx): number {
  if (ep.catchAll ? call.length < ep.segs.length : call.length !== ep.segs.length) return -1;
  let score = 0;
  for (let i = 0; i < ep.segs.length; i++) {
    const c = call[i];
    const e = ep.segs[i];
    if (e === null) score += 1;
    else if (c === e) score += 2;
    else return -1; // an interpolated call segment never matches a literal endpoint segment
  }
  return score;
}
