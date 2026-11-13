// Upward dependency: the data layer reaches into the UI layer for the theme name.
import { themeName } from '../ui/theme';

export function fmt(x: unknown): string {
  return `${themeName()}:${String(x)}`;
}
