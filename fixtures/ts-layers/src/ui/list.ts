import { load } from '../data/store';

export function list(): number[] {
  return load();
}
