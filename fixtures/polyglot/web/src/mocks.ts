import { http, HttpResponse } from 'msw';

declare function getBackendSrv(): { post(url: string, body: unknown): Promise<unknown> };

// An msw mock of a backend route and a request through a client getter: neither is a route served here.
export const handlers = [http.get('/items', () => HttpResponse.json([]))];

export function saveOrder(order: unknown) {
  return getBackendSrv().post('/orders', order);
}

export function saveOrderVia(deps: { getBackendSrv: typeof getBackendSrv }, order: unknown) {
  return deps.getBackendSrv().post('/orders', order);
}

declare const request: { get(url: string): Promise<unknown>; post(url: string, o: object): Promise<unknown> };

// Requests shaped like routes: no handler argument, a body literal, a `this` or `…Client` receiver.
export class Backend {
  httpClient = { post: (url: string, body: string) => [url, body] };
  get(url: string, query: unknown) {
    return [url, query];
  }
  search(q: string) {
    request.get('/items');
    request.post('/orders', { q });
    this.httpClient.post('/orders', JSON.stringify(q));
    return this.get('/items', q);
  }
}
