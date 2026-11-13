import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

const SYMBOL_EDGES = ['calls', 'instantiates', 'references'];

describe('C-4 receiver typing + C-8 references / ts-typed', async () => {
  const { g, stats, en } = await analyzeFixture('ts-typed');

  it('binds exactly these calls and references', () => {
    expect(edgeLabels(g, SYMBOL_EDGES)).toEqual(
      [
        'instantiates src/index.ts::svc -> src/service.ts::UserService',
        'calls src/index.ts::svc -> src/repo.ts::makeRepo',
        'calls src/index.ts -> src/service.ts::UserService.rename',
        'calls src/index.ts -> src/service.ts::audit',
        'calls src/index.ts -> src/repo.ts::makeRepo',
        'instantiates src/repo.ts::UserRepo.latestOrder -> src/models.ts::Order',
        'instantiates src/repo.ts::makeRepo -> src/repo.ts::UserRepo',
        // constructor parameter property `private readonly repo: UserRepo` → this.repo.*
        'calls src/service.ts::UserService.rename -> src/repo.ts::UserRepo.find',
        'calls src/service.ts::UserService.rename -> src/repo.ts::UserRepo.latestOrder',
        // `const order = await this.repo.latestOrder()` typed from `Promise<Order>`
        'calls src/service.ts::UserService.rename -> src/models.ts::Order.total',
        'calls src/service.ts::UserService.rename -> src/repo.ts::UserRepo.save',
        // parameter `repo: UserRepo`, and `const r = makeRepo()` typed from `: UserRepo`
        'calls src/service.ts::audit -> src/repo.ts::UserRepo.find',
        'calls src/service.ts::audit -> src/repo.ts::makeRepo',
        'calls src/service.ts::audit -> src/repo.ts::UserRepo.save',
        'references src/repo.ts::UserRepo.find -> src/models.ts::UserId',
        'references src/repo.ts::UserRepo.find -> src/models.ts::User',
        'references src/repo.ts::UserRepo.find -> src/decorators.ts::logged',
        'references src/repo.ts::UserRepo.latestOrder -> src/models.ts::User',
        'references src/repo.ts::UserRepo.latestOrder -> src/models.ts::Order',
        'references src/repo.ts::UserRepo.save -> src/models.ts::User',
        'references src/repo.ts::makeRepo -> src/repo.ts::UserRepo',
        'references src/service.ts::UserService -> src/models.ts::User', // generic argument Map<string, User>
        'references src/service.ts::UserService.constructor -> src/repo.ts::UserRepo',
        'references src/service.ts::UserService.rename -> src/models.ts::User', // `as User`
        'references src/service.ts::audit -> src/repo.ts::UserRepo',
      ].sort(),
    );
    expect(stats.unresolvedCalls).toBe(0);
    expect(stats.ambiguousCalls).toBe(0);
  });

  it('references are exact', () => {
    for (const e of g.edges.values()) if (e.kind === 'references') expect(e.confidence ?? 1).toBe(1);
  });

  it('dead code sees type references: only the unreferenced interface is flagged', () => {
    const dead = en.diagnostics.filter((d) => d.type === 'dead-code').map((d) => d.title);
    expect(dead).toEqual(['Unused has no references']);
  });
});

describe('C-5 barrels & re-exports / ts-barrels', async () => {
  const { g, stats } = await analyzeFixture('ts-barrels');

  it('resolves through export *, export { default as X }, re-exported imports and namespace barrels', () => {
    expect(edgeLabels(g, SYMBOL_EDGES)).toEqual(
      [
        'instantiates src/main.ts::billing -> src/services/billing.ts::Billing', // export { default as Billing }
        'calls src/main.ts::account -> src/models/account.ts::Account.open', // models.Account via export *
        'calls src/main.ts -> src/services/billing.ts::Billing.charge',
        'instantiates src/main.ts::mailer -> src/services/mailer.ts::Mailer', // import { Mailer }; export { Mailer }
        'calls src/main.ts -> src/services/mailer.ts::Mailer.deliver',
        'instantiates src/models/account.ts::Account.open -> src/models/account.ts::Account',
        'calls src/services/billing.ts::Billing.charge -> src/models/account.ts::Account.close',
        'references src/models/account.ts::Account.open -> src/models/account.ts::Account',
        'references src/services/billing.ts::Billing.charge -> src/models/account.ts::Account',
      ].sort(),
    );
    expect(stats.unresolvedCalls).toBe(0);
    expect(stats.unresolvedImports).toBe(0);
  });
});

describe('C-4/C-5/C-8 python / py-typed', async () => {
  const { g, stats } = await analyzeFixture('py-typed');

  it('types receivers from annotations, self fields and return types; honours __all__ barrels', () => {
    expect(edgeLabels(g, SYMBOL_EDGES)).toEqual(
      [
        'instantiates shop/app.py::build -> shop/core/store.py::Store', // Store via `from shop.core import *` + __all__
        'calls shop/app.py::run -> shop/app.py::build',
        'instantiates shop/app.py::run -> shop/core/models.py::Cart',
        'calls shop/app.py::run -> shop/core/store.py::Store.checkout', // build() -> Store
        'calls shop/app.py::run -> shop/core/models.py::Cart.first', // checkout() -> Cart
        'instantiates shop/app.py::run -> shop/core/models.py::Item', // explicit import of a name outside __all__
        'calls shop/core/store.py::Store.checkout -> shop/core/models.py::Cart.add', // self.cart = cart: Cart
        'calls shop/core/store.py::Store -> shop/core/util.py::traced', // decorator applied at class-definition time
        'references shop/app.py::build -> shop/core/models.py::Cart',
        'references shop/app.py::build -> shop/core/store.py::Store',
        'references shop/core/models.py::Cart -> shop/core/models.py::Item', // class attribute annotation
        'references shop/core/models.py::Cart.add -> shop/core/models.py::Item',
        'references shop/core/models.py::Cart.first -> shop/core/models.py::Item', // Optional[Item]
        'references shop/core/store.py::Store.__init__ -> shop/core/models.py::Cart',
        'references shop/core/store.py::Store.checkout -> shop/core/models.py::Cart',
        'references shop/core/store.py::Store.checkout -> shop/core/util.py::traced', // decorator
      ].sort(),
    );
    expect(stats.unresolvedCalls).toBe(0);
  });
});

describe('existing fixtures gain references', async () => {
  it('ts-express: return annotations reference the User interface', async () => {
    const { g } = await analyzeFixture('ts-express');
    expect(edgeLabels(g, ['references'])).toContain(
      'references src/services/userService.ts::UserService.list -> src/models/user.ts::User',
    );
  });
});
