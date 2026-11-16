import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

describe('csharp / aspnet core fixture', async () => {
  const { g, q, stats, d } = await analyzeFixture('cs-aspnet');
  const edges = edgeLabels(g);
  it('discovers the csproj, aspnetcore and the test project', () => {
    expect(d.frameworks.has('aspnetcore')).toBe(true);
    expect(d.manifests.find((m) => m.ecosystem === 'nuget')?.name).toBe('Api');
    expect(d.files.find((f) => f.path === 'Api.Tests/ProductServiceTests.cs')?.isTest).toBe(true);
  });
  it('resolves namespace usings to the files actually used', () => {
    expect(edges).toContain('imports Api/Services/ProductService.cs -> Api/Data/ProductRepository.cs');
    expect(edges).toContain('imports Api/Program.cs -> Api/Endpoints/TodoEndpoints.cs');
    expect(edges).toContain('imports Api/Controllers/ProductsController.cs -> nuget:Microsoft.AspNetCore');
    expect(stats.unresolvedImports).toBe(0);
  });
  it('binds calls through typed fields, interfaces, records, statics and base classes', () => {
    for (const e of [
      'calls Api/Controllers/ProductsController.cs::ProductsController.GetAll -> Api/Services/IProductService.cs::IProductService.All',
      'calls Api/Controllers/ProductsController.cs::ProductsController.Create -> Api/Models/Product.cs::Product.WithName',
      'calls Api/Services/ProductService.cs::ProductService.Find -> Api/Data/ProductRepository.cs::ProductRepository.ById',
      'calls Api/Services/ProductService.cs::ProductService.All -> Api/Services/ServiceBase.cs::ServiceBase.Audit',
      'calls Api/Endpoints/TodoEndpoints.cs::TodoEndpoints.Create -> Api/Endpoints/TodoEndpoints.cs::TodoEndpoints.Remove',
      'calls Api/Program.cs::DELETE /api/todos/{id} -> Api/Endpoints/TodoEndpoints.cs::TodoEndpoints.Remove',
      'instantiates Api/Services/ProductService.cs::ProductService -> Api/Data/ProductRepository.cs::ProductRepository',
      'extends Api/Services/ProductService.cs::ProductService -> Api/Services/ServiceBase.cs::ServiceBase',
      'implements Api/Services/ProductService.cs::ProductService -> Api/Services/IProductService.cs::IProductService',
    ])
      expect(edges).toContain(e);
    expect(edges.filter((e) => e.startsWith('calls ')).length).toBe(13);
    expect(stats.ambiguousCalls).toBe(0);
  });
  it('detects attribute routes and minimal APIs with MapGroup prefixes', () => {
    const eps = q.endpoints().map((e) => `${e.node.name} -> ${e.handler?.name}`);
    expect(eps.sort()).toEqual([
      'DELETE /api/Products/{id} -> Remove',
      'DELETE /api/todos/{id} -> DELETE /api/todos/{id}',
      'GET /api/Products -> GetAll',
      'GET /api/Products/{id} -> Get',
      'GET /api/todos -> List',
      'GET /health -> GET /health',
      'POST /api/Products -> Create',
      'POST /api/todos -> Create',
    ]);
  });
});
