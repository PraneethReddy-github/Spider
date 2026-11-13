import { load } from '../data/store';

export function detail(i: number): number | undefined {
  return load()[i];
}
