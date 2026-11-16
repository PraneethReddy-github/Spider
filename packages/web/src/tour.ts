import type { Tour } from '@spider/shared';
import { create } from 'zustand';

/** Guided tour (C-27): the running tour and its step; mirrored to `?tour=<id>&step=<n>` so tours share by URL. */
interface TourState {
  tour?: Tour;
  step: number;
  start: (tour: Tour, step?: number) => void;
  go: (step: number) => void;
  stop: () => void;
}

export const useTour = create<TourState>((set, get) => ({
  step: 0,
  start: (tour, step = 0) => set({ tour, step: Math.min(Math.max(0, step), tour.steps.length - 1) }),
  go: (step) => {
    const t = get().tour;
    if (t) set({ step: Math.min(Math.max(0, step), t.steps.length - 1) });
  },
  stop: () => set({ tour: undefined, step: 0 }),
}));

/** `?tour=default&step=2` from the address bar, if any. */
export function tourFromUrl(search = window.location.search): { id: string; step: number } | undefined {
  const sp = new URLSearchParams(search);
  const id = sp.get('tour');
  return id ? { id, step: Math.max(0, Number(sp.get('step')) || 0) } : undefined;
}
