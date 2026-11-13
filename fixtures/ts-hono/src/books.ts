import { Hono } from 'hono';

const books = new Hono();
books.get('/', (c) => c.json([]));
books.post('/:id', createBook);

export function createBook(c: any) { return c.json({}); }
export default books;
