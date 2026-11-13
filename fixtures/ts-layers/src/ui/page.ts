import { fmt } from '../data/format';
import { load } from '../data/store';

export function render(): string {
  return fmt(load());
}
