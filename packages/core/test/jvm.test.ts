import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

const J = 'src/main/java/com/example/petshop';
const K = 'src/main/kotlin/com/example/greet';

describe('java / spring fixture', async () => {
  const { g, q, stats, d } = await analyzeFixture('java-spring');
  const edges = edgeLabels(g);
  it('discovers the maven manifest, spring and test sources', () => {
    expect(d.frameworks.has('spring')).toBe(true);
    expect(d.manifests.find((m) => m.ecosystem === 'maven')?.name).toBe('petshop');
    expect(d.files.find((f) => f.path.endsWith('OwnerControllerTest.java'))?.isTest).toBe(true);
  });
  it('resolves single-type, wildcard, static and external imports', () => {
    expect(edges).toContain(`imports ${J}/web/OwnerController.java -> ${J}/service/OwnerService.java`);
    expect(edges).toContain(`imports ${J}/web/OwnerController.java -> ${J}/model/Owner.java`); // model.*
    expect(edges).toContain(`imports ${J}/service/AuditedService.java -> ${J}/util/Strings.java`); // import static
    expect(edges).toContain(`imports ${J}/repo/OwnerRepository.java -> jdk:java.util`);
    expect(edges).toContain(`imports ${J}/web/OwnerController.java -> maven:org.springframework`);
    expect(stats.unresolvedImports).toBe(0);
  });
  it('binds calls through typed fields, params, locals, statics, inheritance and interfaces', () => {
    for (const e of [
      `calls ${J}/web/OwnerController.java::OwnerController.list -> ${J}/service/OwnerService.java::OwnerService.findAll`,
      `calls ${J}/web/OwnerController.java::OwnerController.show -> ${J}/service/OwnerService.java::OwnerService.find`,
      `calls ${J}/web/OwnerController.java::OwnerController.create -> ${J}/model/Owner.java::Owner.rename`,
      `calls ${J}/web/OwnerController.java::OwnerController.create -> ${J}/model/Owner.java::Owner.getName`,
      `calls ${J}/service/DefaultOwnerService.java::DefaultOwnerService.find -> ${J}/repo/OwnerRepository.java::OwnerRepository.byId`,
      `calls ${J}/service/AuditedService.java::AuditedService.audit -> ${J}/util/Strings.java::Strings.normalize`,
      `calls ${J}/model/Owner.java::Owner.constructor -> ${J}/util/Strings.java::Strings.normalize`,
      `calls ${J}/service/DefaultOwnerService.java::DefaultOwnerService.findAll -> ${J}/service/AuditedService.java::AuditedService.audit`,
      `instantiates ${J}/service/DefaultOwnerService.java::DefaultOwnerService -> ${J}/repo/OwnerRepository.java::OwnerRepository`,
      `extends ${J}/service/DefaultOwnerService.java::DefaultOwnerService -> ${J}/service/AuditedService.java::AuditedService`,
      `implements ${J}/service/DefaultOwnerService.java::DefaultOwnerService -> ${J}/service/OwnerService.java::OwnerService`,
      `references ${J}/web/OwnerController.java::OwnerController.list -> ${J}/model/Owner.java::Owner`,
    ])
      expect(edges).toContain(e);
    const inherited = [...g.edges.values()].find((e) => g.getNode(e.dst)?.name === 'audit' && e.kind === 'calls');
    expect(inherited?.confidence).toBe(0.9);
  });
  it('never guesses: library receivers and lambdas bind nothing', () => {
    expect(edges.filter((e) => e.startsWith('calls ')).length).toBe(16);
    expect([...g.edges.values()].every((e) => e.kind !== 'calls' || (e.confidence ?? 1) >= 0.9)).toBe(true);
    expect(stats.ambiguousCalls).toBe(0);
    expect(stats.unresolvedCalls).toBe(0);
  });
  it('detects spring endpoints with class prefixes', () => {
    const eps = q.endpoints().map((e) => `${e.node.name} -> ${e.handler?.name}`);
    expect(eps.sort()).toEqual([
      'DELETE /api/owners/{id} -> remove',
      'GET /api/owners -> list',
      'GET /api/owners/search -> search',
      'GET /api/owners/{id} -> show',
      'POST /api/owners/ -> create',
    ]);
  });
});

describe('kotlin / spring fixture', async () => {
  const { g, q, stats, d } = await analyzeFixture('kotlin-spring');
  const edges = edgeLabels(g);
  it('discovers the gradle manifest and spring', () => {
    expect(d.frameworks.has('spring')).toBe(true);
    expect(d.manifests.find((m) => m.path === 'build.gradle.kts')?.deps.map((x) => x.name)).toContain(
      'org.springframework.boot:spring-boot-starter-web',
    );
  });
  it('resolves imports incl. top-level functions', () => {
    expect(edges).toContain(`imports ${K}/service/AuditedService.kt -> ${K}/util/Logging.kt`);
    expect(edges).toContain(`imports ${K}/web/GreetingController.kt -> ${K}/service/GreetingService.kt`);
    expect(stats.unresolvedImports).toBe(0);
  });
  it('binds calls through constructor properties, typed locals, inheritance and top-level functions', () => {
    for (const e of [
      `calls ${K}/web/GreetingController.kt::GreetingController.list -> ${K}/service/GreetingService.kt::GreetingService.all`,
      `calls ${K}/web/GreetingController.kt::GreetingController.one -> ${K}/model/Greeting.kt::Greeting.shout`,
      `calls ${K}/service/GreetingService.kt::GreetingService.add -> ${K}/repo/GreetingRepository.kt::GreetingRepository.save`,
      `calls ${K}/service/GreetingService.kt::GreetingService.all -> ${K}/service/AuditedService.kt::AuditedService.audit`,
      `calls ${K}/service/AuditedService.kt::AuditedService.audit -> ${K}/util/Logging.kt::log`,
      `instantiates ${K}/service/GreetingService.kt::GreetingService -> ${K}/model/Greeting.kt::Greeting`,
      `extends ${K}/service/GreetingService.kt::GreetingService -> ${K}/service/AuditedService.kt::AuditedService`,
    ])
      expect(edges).toContain(e);
    expect(edges.filter((e) => e.startsWith('calls ')).length).toBe(11);
    expect(stats.ambiguousCalls).toBe(0);
  });
  it('detects spring endpoints incl. RequestMapping(method = [...])', () => {
    const eps = q.endpoints().map((e) => `${e.node.name} -> ${e.handler?.name}`);
    expect(eps.sort()).toEqual([
      'DELETE /api/greetings/purge -> purge',
      'GET /api/greetings -> list',
      'GET /api/greetings/{id} -> one',
      'POST /api/greetings -> create',
    ]);
  });
});
