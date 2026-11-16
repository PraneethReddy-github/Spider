import type { Span } from '@spider/shared';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import type { CallFact, DeclFact } from '../languages/types.js';
import { callerOf } from './resolve-http.js';
import { type FileTable, type SymbolEntry, findBinding, lookupDotted } from './resolve.js';

/**
 * C-20 datastore heuristics → `datastore` nodes + `reads`/`writes` edges from the accessing symbol.
 *
 * Containment: `repo → database → <table>`, `repo → queues → <topic>`, `repo → redis` (grouping nodes are
 * `datastore`s too, created only when they get a child). Tables are keyed by a normalised singular name, so
 * `users` (SQL), `User` (ORM model) and `prisma.user` meet in one node.
 *
 * Sources (precision first, all below 1): SQL string literals (small tokenizer, 0.9); ORM models — Prisma
 * client calls, TypeORM/JPA `@Entity` + repositories (Spring Data interfaces, `Repository<T>` fields),
 * Sequelize/TypeORM static model calls, Django `Model.objects`, SQLAlchemy `query/select/insert/update/delete
 * (Model)`, GORM `db.Find(&T{})`, EF Core `DbSet<T>` properties (0.9; 0.8 when the model comes from a name);
 * Redis clients (0.8); queue producers/consumers — Kafka, RabbitMQ, SQS/SNS, BullMQ, Celery tasks (0.7).
 */

type Access = { kind: 'reads' | 'writes'; system: 'sql' | 'redis' | 'queue'; name: string; confidence: number };

const GROUP_NAME = { sql: 'database', queue: 'queues', redis: 'redis' } as const;

/* ---------- SQL ---------- */

const SQL_START =
  /^\s*\(?\s*(SELECT\s[\s\S]*?\sFROM\s|INSERT\s+(INTO\s|OR\s)|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|WITH\s+\w+\s+AS\s*\(|MERGE\s+INTO\s)/i;
const SQL_KEYWORDS = new Set(
  'select from where join inner left right outer full cross on as set values into update delete insert with lateral only dual unnest table group order by limit offset having union all distinct and or not in exists returning do nothing conflict natural using'.split(
    ' ',
  ),
);

const SQL_PART = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
/** Identifiers (optionally quoted, dotted `"public"."users"`), `{}` placeholders and punctuation. */
const SQL_TOKEN = new RegExp(`${SQL_PART}(?:\\.${SQL_PART})*|\\{\\}|[(),;]`, 'g');

/** Table names read and written by one SQL string (not a parser: FROM/JOIN/INTO/UPDATE/DELETE FROM). */
export function sqlTables(sql: string): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const toks = sql.match(SQL_TOKEN) ?? [];
  const ident = (i: number, columns = false): string | undefined => {
    const t = toks[i]?.replace(/["`[\]]/g, '');
    if (!t || !/^[A-Za-z_][\w$.]*$/.test(t) || SQL_KEYWORDS.has(t.toLowerCase())) return undefined;
    if (toks[i + 1] === '(' && !columns) return undefined; // a function call (generate_series(…))
    return t.split('.').pop();
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].toLowerCase();
    const prev = toks[i - 1]?.toLowerCase();
    if (t === 'into' && (prev === 'insert' || prev === 'replace' || prev === 'merge' || prev === 'ignore')) {
      const n = ident(i + 1, true); // INSERT INTO t (cols)
      if (n) writes.add(n);
    } else if (t === 'update' && prev !== 'do' && prev !== 'for' && toks[i + 2]?.toLowerCase() === 'set') {
      const n = ident(i + 1);
      if (n) writes.add(n);
    } else if (t === 'from' && prev === 'delete') {
      const n = ident(i + 1);
      if (n) writes.add(n);
    } else if (t === 'from' || t === 'join') {
      // FROM a [AS] x, b y
      let j = i + 1;
      while (j < toks.length) {
        const n = ident(j);
        if (!n) break;
        reads.add(n);
        j++;
        if (toks[j]?.toLowerCase() === 'as') j++;
        if (toks[j] && ident(j)) j++;
        if (toks[j] !== ',' || t === 'join') break;
        j++;
      }
    }
  }
  for (const w of writes) reads.delete(w);
  return { reads: [...reads], writes: [...writes] };
}

/** `Users`, `users`, `user`, `UserCategories` → `user` / `usercategory`: one key per table/model. */
export function tableKey(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (n.endsWith('ies') && n.length > 4) return `${n.slice(0, -3)}y`;
  if (/(ss|x|z|ch|sh)es$/.test(n)) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss') && n.length > 2) return n.slice(0, -1);
  return n;
}

/* ---------- ORM ---------- */

const ORM_STATIC_READ = new Set([
  'findAll',
  'findOne',
  'findByPk',
  'findAndCountAll',
  'count',
  'find',
  'findBy',
  'findOneBy',
  'findOneOrFail',
  'findAndCount',
]);
const ORM_STATIC_WRITE = new Set(['create', 'bulkCreate', 'update', 'destroy', 'upsert', 'insert', 'delete', 'remove']);
const REPO_READ = /^(find|get|count|exists|read|query|search|stream|load|fetch|list)/;
const REPO_WRITE =
  /^(save|delete|insert|update|remove|create|persist|upsert|merge|softDelete|softRemove|increment|decrement|restore|clear|flush)/;
const DJANGO_WRITE = new Set([
  'create',
  'update',
  'delete',
  'bulk_create',
  'bulk_update',
  'get_or_create',
  'update_or_create',
]);
const EF_READ =
  /^(Find|First|Single|Where|Any|All|Count|LongCount|Sum|Max|Min|Average|To|AsNoTracking|AsQueryable|Include|Select|OrderBy|Last|Contains|Skip|Take|FromSql)/;
const EF_WRITE = /^(Add|Remove|Update|Attach|ExecuteUpdate|ExecuteDelete)/;
const GORM_READ = new Set(['Find', 'First', 'Take', 'Last', 'Scan', 'Count', 'Pluck']);
const GORM_WRITE = new Set(['Create', 'Save', 'Updates', 'Update', 'Delete', 'CreateInBatches', 'FirstOrCreate']);
const PRISMA_READ = new Set([
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);
const PRISMA_WRITE = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const SA_READ = new Set(['query', 'select', 'get']);
const SA_WRITE = new Set(['insert', 'update', 'delete']);
const SPRING_REPO = /(^|\.)(\w*Repository|JpaSpecificationExecutor)$/;

/* ---------- Redis & queues ---------- */

const REDIS_READ = new Set(
  'get mget hget hgetall hmget hkeys hvals hexists hlen lrange lindex llen smembers sismember scard zrange zrangebyscore zrevrange zscore zcard exists keys scan ttl xread xrange getrange strlen stringget hashget hashgetall setmembers listrange keyexists'.split(
    ' ',
  ),
);
const REDIS_WRITE = new Set(
  'set delete setex setnx psetex mset getset getdel del unlink hset hmset hsetnx hdel hincrby lpush rpush lpop rpop lrem ltrim sadd srem spop zadd zrem zincrby incr incrby decr decrby expire expireat persist xadd append stringset stringincrement hashset hashdelete keydelete keyexpire listleftpush listrightpush setadd setremove'.split(
    ' ',
  ),
);
const QUEUE_RECEIVER =
  /(producer|consumer|kafka|channel|queue|publisher|subscriber|sqs|sns|pubsub|rabbit|amqp|broker|mq|^ch|^chan|(kafka|rabbit|amqp|jms)template)$/i;
const QUEUE_WRITE = new Set([
  'send',
  'publish',
  'produce',
  'sendToQueue',
  'convertAndSend',
  'basic_publish',
  'sendMessage',
  'sendMessageBatch',
]);
const QUEUE_READ = new Set(['subscribe', 'consume', 'basic_consume', 'receiveMessage']);
const CELERY_TASK = /(^|\.)(shared_task|task)$/;

interface EntityIx {
  /** Model class symbol id → table key. */
  byId: Map<string, string>;
  /** Table key → display name (first model / table seen). */
  names: Map<string, string>;
  /** Go struct name → how many packages declare it (GORM models are plain structs). */
  goStructs: Map<string, number>;
}

export function resolveData(
  g: GraphBuilder,
  all: FileTable[],
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): void {
  const entities = indexEntities(all, tables, globalByName);
  const prod = new Set<string>();
  const emit = (table: FileTable, from: string, a: Access, span: Span, via: string) => {
    const key = a.system === 'redis' ? '' : a.system === 'sql' ? tableKey(a.name) : a.name;
    if (!key && a.system !== 'redis') return;
    const group = ids.datastore(a.system, '');
    const isTest = !!g.getNode(table.fileId)?.props.isTest;
    if (!g.hasNode(group))
      g.addNode({
        id: group,
        kind: 'datastore',
        name: GROUP_NAME[a.system],
        parentId: 'repo',
        props: { system: a.system },
      });
    let id = group;
    if (a.system !== 'redis') {
      id = ids.datastore(a.system, key);
      if (!g.hasNode(id))
        g.addNode({
          id,
          kind: 'datastore',
          name: a.system === 'sql' ? (entities.names.get(key) ?? a.name) : a.name,
          qname: `${a.system}:${a.name}`,
          parentId: group,
          props: { system: a.system, inferred: true },
        });
    }
    if (!isTest) prod.add(id).add(group);
    g.addEdge(a.kind, from, id, { confidence: a.confidence, evidence: span, props: { via } });
  };

  const celery = celeryTasks(all);
  for (const table of all) {
    for (const call of table.facts.calls) {
      const from = callerOf(table, call.callerQname);
      for (const s of call.args ?? []) {
        if (!s?.s || !SQL_START.test(s.s)) continue;
        const t = sqlTables(s.s);
        for (const n of t.reads)
          emit(table, from, { kind: 'reads', system: 'sql', name: n, confidence: 0.9 }, call.span, 'sql');
        for (const n of t.writes)
          emit(table, from, { kind: 'writes', system: 'sql', name: n, confidence: 0.9 }, call.span, 'sql');
      }
      const a =
        ormAccess(table, call, entities, tables, globalByName) ??
        redisAccess(table, call) ??
        queueAccess(table, call, celery, tables, globalByName);
      if (a) emit(table, from, a.access, call.span, a.via);
    }
    // a Celery task function consumes its own queue
    for (const [qn, e] of table.own)
      if (celery.has(e.id))
        emit(table, e.id, { kind: 'reads', system: 'queue', name: qn, confidence: 0.7 }, e.decl.span, 'celery');
  }
  // a store only test code touches is test-only (hidden with tests)
  for (const n of g.nodesOfKind('datastore')) n.props.isTest = !prod.has(n.id);
}

function indexEntities(all: FileTable[], tables: Map<string, FileTable>, globalByName: Map<string, SymbolEntry[]>) {
  const ix: EntityIx = { byId: new Map(), names: new Map(), goStructs: new Map() };
  const add = (e: SymbolEntry) => {
    const key = tableKey(e.decl.name);
    ix.byId.set(e.id, key);
    if (!ix.names.has(key)) ix.names.set(key, e.decl.name);
  };
  const sqlalchemyBase = all.some((t) =>
    t.facts.calls.some((c) => c.callee === 'declarative_base' || c.callee.endsWith('.declarative_base')),
  );
  for (const table of all) {
    const lang = table.facts.language;
    for (const e of table.own.values()) {
      const d = e.decl;
      if (d.kind !== 'class') continue;
      if (lang === 'go') ix.goStructs.set(d.name, (ix.goStructs.get(d.name) ?? 0) + 1);
      const ext = d.extends ?? [];
      const isEntity =
        (d.decorators ?? []).some((x) => /^(Entity|Table)$/.test(x.split('.').pop() ?? '')) ||
        ext.some(
          (x) =>
            /^(models\.Model|db\.Model|DeclarativeBase|BaseEntity)$/.test(x) ||
            (x === 'Base' && lang === 'python' && sqlalchemyBase) ||
            (x === 'Model' && importsAny(table, /^(sequelize|sequelize-typescript|objection)$/)),
        );
      if (isEntity) add(e);
      // EF Core: every DbSet<T> of a DbContext names an entity
      if (ext.some((x) => /DbContext$/.test(x)))
        for (const r of table.facts.references ?? []) {
          if (r.scopeQname !== d.qname || /^(DbSet|DbContext)$/.test(r.name)) continue;
          const t = lookupDotted(table, r.name, tables, globalByName, d.qname);
          const target = t?.length === 1 && t[0].confidence >= 0.9 ? table.ctx.byId.get(t[0].id) : undefined;
          if (target?.entry.decl.kind === 'class') add(target.entry);
        }
    }
  }
  return ix;
}

function importsAny(table: FileTable, re: RegExp): boolean {
  return table.facts.imports.some((i) => re.test(i.specifier));
}

/** The repo class a dotted reference binds to exactly (JS/Python/JVM/C#). */
function classOf(
  table: FileTable,
  ref: string,
  scope: string | undefined,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): { table: FileTable; entry: SymbolEntry } | undefined {
  const t = lookupDotted(table, ref, tables, globalByName, scope);
  if (t?.length !== 1 || t[0].confidence < 0.9) return undefined;
  const c = table.ctx.byId.get(t[0].id);
  return c?.entry.decl.kind === 'class' ? c : undefined;
}

/** The entity a name refers to: a resolved model class, else a model whose table key matches. */
function entityKey(
  table: FileTable,
  ref: string,
  scope: string | undefined,
  ix: EntityIx,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): string | undefined {
  const c = classOf(table, ref, scope, tables, globalByName);
  return c ? ix.byId.get(c.entry.id) : undefined;
}

function ormAccess(
  table: FileTable,
  call: CallFact,
  ix: EntityIx,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): { access: Access; via: string } | undefined {
  const lang = table.facts.language;
  const segs = call.callee.split('.');
  const op = segs[segs.length - 1];
  const scope = call.callerQname;
  const acc = (kind: 'reads' | 'writes', name: string, via: string, confidence = 0.9) => ({
    access: { kind, system: 'sql' as const, name, confidence },
    via,
  });
  const nameOf = (key: string) => ix.names.get(key) ?? key;

  // Prisma: prisma.user.findMany() · this.prisma.post.create() · ctx.db.user.update()
  if ((lang === 'typescript' || lang === 'javascript') && segs.length >= 3) {
    const recv = segs.slice(0, -2).join('.');
    if (/(^|\.)(prisma|db)$/i.test(recv) && (PRISMA_READ.has(op) || PRISMA_WRITE.has(op))) {
      const model = segs[segs.length - 2];
      return acc(PRISMA_READ.has(op) ? 'reads' : 'writes', ix.names.get(tableKey(model)) ?? model, 'prisma');
    }
  }
  // GORM: db.Find(&User{}) — the struct named by a composite literal argument
  if (lang === 'go' && (GORM_READ.has(op) || GORM_WRITE.has(op)) && importsAny(table, /gorm/)) {
    const r = call.args?.find((a) => a?.r)?.r;
    if (r && ix.goStructs.get(r) === 1) return acc(GORM_READ.has(op) ? 'reads' : 'writes', r as string, 'gorm');
    return undefined;
  }
  if (lang === 'go' || lang === 'rust') return undefined;
  // SQLAlchemy: session.query(User) · select(User) · insert(User) · session.get(User, id)
  if (lang === 'python' && (SA_READ.has(op) || SA_WRITE.has(op))) {
    const r = call.args?.[0]?.r;
    const key = r ? entityKey(table, r, scope, ix, tables, globalByName) : undefined;
    if (key) return acc(SA_WRITE.has(op) ? 'writes' : 'reads', nameOf(key), 'sqlalchemy');
  }
  if (segs.length < 2) return undefined;

  // Django: Model.objects.filter() / .create()
  if (segs.length >= 3 && segs[segs.length - 2] === 'objects') {
    const key = entityKey(table, segs.slice(0, -2).join('.'), scope, ix, tables, globalByName);
    if (key) return acc(DJANGO_WRITE.has(op) ? 'writes' : 'reads', nameOf(key), 'django');
  }
  const recv = segs.slice(0, -1).join('.');
  // Sequelize / TypeORM active record: User.findAll() · User.create()
  if (ORM_STATIC_READ.has(op) || ORM_STATIC_WRITE.has(op)) {
    const key = entityKey(table, recv, scope, ix, tables, globalByName);
    if (key) return acc(ORM_STATIC_WRITE.has(op) ? 'writes' : 'reads', nameOf(key), 'orm');
  }
  // EF Core: _db.Users.Add(u) · context.Orders.Where(…)
  if (lang === 'csharp' && segs.length >= 3 && (EF_READ.test(op) || EF_WRITE.test(op))) {
    const ctxRef = segs.slice(0, -2).join('.');
    const b = findBinding(table, ctxRef, scope) ?? findBinding(table, `this.${ctxRef}`, scope);
    const ctx = b ? classOf(table, b.ref, b.scope || undefined, tables, globalByName) : undefined;
    if (ctx && (ctx.entry.decl.extends ?? []).some((x) => /DbContext$/.test(x))) {
      const key = tableKey(segs[segs.length - 2]);
      if (ix.names.has(key)) return acc(EF_WRITE.test(op) ? 'writes' : 'reads', nameOf(key), 'efcore');
    }
    return undefined;
  }
  // repositories: Spring Data `OwnerRepository extends JpaRepository<Owner, …>` · TypeORM `Repository<User>`
  if (REPO_READ.test(op) || REPO_WRITE.test(op)) {
    const b = findBinding(table, recv, scope);
    if (!b) return undefined;
    const kind = REPO_WRITE.test(op) ? 'writes' : 'reads';
    const repo = classOf(table, b.ref, b.scope || undefined, tables, globalByName);
    if (repo && (repo.entry.decl.extends ?? []).some((x) => SPRING_REPO.test(x))) {
      const key = repoEntity(repo, ix, tables, globalByName);
      return key ? acc(kind, nameOf(key.key), 'repository', key.confidence) : undefined;
    }
    if (!repo && /^(Repository|MongoRepository|TreeRepository)$/.test(b.ref)) {
      // the field name says which model: `userRepository`, `usersRepo`
      const m = /^(?:this\.)?_?(\w+?)(?:Repository|Repo)$/.exec(recv);
      const key = m ? tableKey(m[1]) : undefined;
      if (key && ix.names.has(key)) return acc(kind, nameOf(key), 'repository', 0.8);
    }
  }
  return undefined;
}

/** A Spring Data repository's entity: a model in its generic arguments, else its name (`OwnerRepository`). */
function repoEntity(
  repo: { table: FileTable; entry: SymbolEntry },
  ix: EntityIx,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): { key: string; confidence: number } | undefined {
  const qn = repo.entry.decl.qname;
  const keys = new Set<string>();
  for (const r of repo.table.facts.references ?? []) {
    if (r.scopeQname !== qn) continue;
    const k = entityKey(repo.table, r.name, qn, ix, tables, globalByName);
    if (k) keys.add(k);
  }
  if (keys.size === 1) return { key: [...keys][0], confidence: 0.9 };
  const m = /^(\w+?)(Repository|Repo|Dao)$/.exec(repo.entry.decl.name);
  const key = m ? tableKey(m[1]) : undefined;
  return key && ix.names.has(key) ? { key, confidence: 0.8 } : undefined;
}

function redisAccess(table: FileTable, call: CallFact): { access: Access; via: string } | undefined {
  const segs = call.callee.replace(/::/g, '.').split('.');
  if (segs.length < 2) return undefined;
  const op = segs[segs.length - 1].toLowerCase().replace(/async$/, '');
  if (!REDIS_READ.has(op) && !REDIS_WRITE.has(op)) return undefined;
  const recv = segs.slice(0, -1).join('.');
  const b = findBinding(table, recv, call.callerQname);
  if (!/redis/i.test(segs[segs.length - 2]) && !(b && /redis/i.test(b.ref))) return undefined;
  return {
    access: { kind: REDIS_WRITE.has(op) ? 'writes' : 'reads', system: 'redis', name: 'redis', confidence: 0.8 },
    via: 'redis',
  };
}

function celeryTasks(all: FileTable[]): Set<string> {
  const out = new Set<string>();
  for (const t of all)
    if (t.facts.language === 'python')
      for (const e of t.own.values()) if ((e.decl.decorators ?? []).some((d) => CELERY_TASK.test(d))) out.add(e.id);
  return out;
}

function queueAccess(
  table: FileTable,
  call: CallFact,
  celery: Set<string>,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): { access: Access; via: string } | undefined {
  const segs = call.callee.split('.');
  const op = segs[segs.length - 1];
  const recv = segs.slice(0, -1).join('.');
  const write = (name: string, via: string): { access: Access; via: string } => ({
    access: { kind: 'writes', system: 'queue', name, confidence: 0.7 },
    via,
  });
  // Celery: send_email.delay(…) / .apply_async(…)
  if ((op === 'delay' || op === 'apply_async') && table.facts.language === 'python' && recv) {
    const t = lookupDotted(table, recv, tables, globalByName, call.callerQname);
    const task =
      t?.length === 1 && t[0].confidence >= 0.9 && celery.has(t[0].id) ? table.ctx.byId.get(t[0].id) : undefined;
    return task ? write(task.entry.decl.qname, 'celery') : undefined;
  }
  // BullMQ: queue.add(…) on `new Queue('emails')`; `new Worker('emails', fn)` consumes
  const bull = importsAny(table, /^bullmq$|^bull$/);
  if (bull && call.isNew && (call.callee === 'Worker' || call.callee === 'QueueEvents')) {
    const name = call.args?.[0]?.s;
    return name && isTopic(name)
      ? { access: { kind: 'reads', system: 'queue', name, confidence: 0.7 }, via: 'bullmq' }
      : undefined;
  }
  if (bull && (op === 'add' || op === 'addBulk') && recv) {
    const b = findBinding(table, recv, call.callerQname);
    if (b?.isNew && b.ref === 'Queue') {
      const name = initArg(table, recv, b.ref) ?? recv.replace(/^this\./, '');
      return write(name, 'bullmq');
    }
  }
  if (!QUEUE_WRITE.has(op) && !QUEUE_READ.has(op)) return undefined;
  if (!recv || !QUEUE_RECEIVER.test(segs[segs.length - 2])) return undefined;
  const kw = call.kw ?? {};
  const args = call.args ?? [];
  const topic =
    kw.topic ??
    kw.QueueUrl?.split('/').pop() ??
    kw.TopicArn?.split(':').pop() ??
    kw.routing_key ??
    kw.queue ??
    (op === 'publish' && args[0]?.s === '' ? args[1]?.s : args[0]?.s);
  if (!topic || !isTopic(topic)) return undefined;
  return {
    access: { kind: QUEUE_WRITE.has(op) ? 'writes' : 'reads', system: 'queue', name: topic, confidence: 0.7 },
    via: 'queue',
  };
}

function isTopic(s: string): boolean {
  return /^[\w.\-:]+$/.test(s) && !s.endsWith('.js') && !s.endsWith('.ts');
}

/** First string argument of the constructor call that initialises module variable `name` (`new Queue('x')`). */
function initArg(table: FileTable, name: string, ref: string): string | undefined {
  const decl: DeclFact | undefined = table.own.get(name)?.decl;
  if (!decl) return undefined;
  const c = table.facts.calls.find(
    (x) => x.callee === ref && x.span.startLine >= decl.span.startLine && x.span.endLine <= decl.span.endLine,
  );
  return c?.args?.[0]?.s;
}
