import { Hono } from 'hono';
import books from './books';

const app = new Hono();
const api = new Hono().basePath('/api');
api.route('/books', books);
app.route('/v1', api);
app.get('/health', (c) => c.text('ok'));
export default app;
