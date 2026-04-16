/**
 * SM-2 Spaced Repetition Algorithm
 *
 * score: 0-5 (0-2 = fail/repeat, 3 = hard, 4 = good, 5 = easy)
 */

export interface SRCard {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
}

export interface SRResult extends SRCard {
  next_review: string; // ISO date
}

export function sm2(card: SRCard, score: number): SRResult {
  let { ease_factor, interval_days, repetitions } = card;

  if (score < 3) {
    // Failed — reset
    repetitions = 0;
    interval_days = 1;
  } else {
    // Passed
    if (repetitions === 0) {
      interval_days = 1;
    } else if (repetitions === 1) {
      interval_days = 6;
    } else {
      interval_days = Math.round(interval_days * ease_factor);
    }
    repetitions += 1;
  }

  // Update ease factor
  ease_factor = ease_factor + (0.1 - (5 - score) * (0.08 + (5 - score) * 0.02));
  if (ease_factor < 1.3) ease_factor = 1.3;

  // Calculate next review date
  const next = new Date();
  next.setDate(next.getDate() + interval_days);
  const next_review = next.toISOString().split("T")[0];

  return { ease_factor, interval_days, repetitions, next_review };
}
