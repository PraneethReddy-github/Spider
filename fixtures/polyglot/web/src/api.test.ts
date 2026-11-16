import { expect, it } from 'vitest';

it('lists items', async () => {
  const res = await fetch('/items');
  expect(res.ok).toBe(true);
  await fetch(`/items/${'x'}`);
});
