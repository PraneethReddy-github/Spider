import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../api';
import { useReveal } from '../hooks';
import { useStore } from '../store';
import { tourFromUrl, useTour } from '../tour';
import { IconButton } from '../ui';
import './TourPlayer.css';

/** Plays a guided tour over the map: each step reveals its node and shows the narration (C-27). */
export function TourPlayer({ repoId }: { repoId: string }) {
  const { tour, step, start, go, stop } = useTour();
  const reveal = useReveal();
  const fromUrl = tourFromUrl();
  // a shared link (`?tour=default&step=n`) starts the tour on load
  const shared = useQuery({
    queryKey: ['tour', repoId, 'default'],
    queryFn: () => api.tour(repoId),
    enabled: fromUrl?.id === 'default' && !tour,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (shared.data && !useTour.getState().tour) start(shared.data, fromUrl?.step ?? 0);
  }, [shared.data, start, fromUrl?.step]);
  useEffect(() => () => stop(), [stop]); // leaving the repo ends the tour

  const s = tour?.steps[step];
  useEffect(() => {
    if (!s) return;
    const st = useStore.getState();
    if (st.view !== 'map') st.setView('map');
    if (s.nodeId) void reveal(s.nodeId);
    else {
      if (st.level !== s.level) st.setLevel(s.level);
      st.select(undefined);
    }
  }, [s, reveal]);
  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowRight') go(step + 1);
      else if (e.key === 'ArrowLeft') go(step - 1);
      else if (e.key === 'Escape') stop();
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tour, step, go, stop]);

  if (!tour || !s) return null;
  const last = step === tour.steps.length - 1;
  return (
    <section className="overlay tour-player" aria-label={tour.title} aria-live="polite">
      <header className="tour-head">
        <span className="t-caption tone-3">
          {tour.title} · {step + 1} of {tour.steps.length}
        </span>
        <IconButton label="End tour" onClick={stop}>
          <X size={16} strokeWidth={1.5} />
        </IconButton>
      </header>
      <h2 className="tour-title">{s.title}</h2>
      <p className="tour-text">{s.text}</p>
      <footer className="tour-foot">
        <button type="button" className="btn btn-ghost" disabled={step === 0} onClick={() => go(step - 1)}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={() => (last ? stop() : go(step + 1))}>
          {last ? 'Finish' : 'Next'}
        </button>
      </footer>
    </section>
  );
}
