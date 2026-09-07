export const STORY_END = 8.4;
export const clamp = value => Math.max(0, Math.min(1, value));
export const mix = (a, b, t) => a + (b - a) * t;
export const ease = (a, b, value) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };

// Reduced motion swaps between complete, still compositions, including the overhead grid.
export function stillProgress(progress) {
  if (progress >= 6.85) return STORY_END;
  if (progress >= 5.6) return 6.5;
  return [0, 1.1, 2.1, 3.25, 4.5, 5.25][Math.min(5, Math.floor(progress + .4))];
}
