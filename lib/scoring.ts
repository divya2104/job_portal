// Scoring rubric and routing (PLAN.md §6, D1, D2). The total is computed here, never taken from the model.
import { z } from "zod";

export const WEIGHTS = {
  skills_match: 0.4,
  seniority_fit: 0.25,
  domain_fit: 0.15,
  location_workmode: 0.1,
  compensation_fit: 0.1,
} as const;
export type Criterion = keyof typeof WEIGHTS;
const CRITERIA = Object.keys(WEIGHTS) as Criterion[];

const Score = z.object({ score: z.number().nullable(), why: z.string() });

/** Shape requested from the model (structured output). Field order puts JD requirements before the CV match. */
export const EvalOutput = z.object({
  requirements: z.array(z.object({
    requirement: z.string(),
    importance: z.enum(["critical", "high", "meaningful", "preferred", "low_signal"]),
    match: z.enum(["strong", "partial", "missing"]),
    cv_evidence: z.string().nullable(),
  })),
  role_family_match: z.boolean(),
  criteria: z.object({
    skills_match: Score, seniority_fit: Score, domain_fit: Score, location_workmode: Score, compensation_fit: Score,
  }),
  rationale: z.string(),
  matched_skills: z.array(z.string()),
  missing_skills: z.array(z.string()),
  legitimacy: z.object({ tier: z.enum(["high_confidence", "proceed_with_caution", "suspicious"]), signals: z.array(z.string()) }),
  injection_flags: z.array(z.string()),
});
export type EvalOutput = z.infer<typeof EvalOutput>;

/** Stricter checks the JSON schema can't express. Throws with a message the model can act on. */
export function validateEval(e: EvalOutput): EvalOutput {
  for (const c of CRITERIA) {
    const s = e.criteria[c].score;
    if (s !== null && !(s >= 0 && s <= 5)) throw new Error(`criteria.${c}.score must be between 0 and 5 or null, got ${s}`);
  }
  if (CRITERIA.every((c) => e.criteria[c].score === null)) throw new Error("at least one criterion must have a score");
  if (e.rationale.trim().length < 20) throw new Error("rationale must be 2–3 sentences");
  return e;
}

/** Weighted mean over non-null criteria (weights renormalised), role-family cap at 1.0, rounded to 2 dp. */
export function computeTotal(e: Pick<EvalOutput, "criteria" | "role_family_match">): number {
  let sum = 0, w = 0;
  for (const c of CRITERIA) {
    const s = e.criteria[c].score;
    if (s === null) continue;
    sum += WEIGHTS[c] * s;
    w += WEIGHTS[c];
  }
  let total = w ? sum / w : 0;
  if (!e.role_family_match) total = Math.min(total, 1);
  return Math.round(total * 100) / 100;
}

export type Route = "apply" | "review" | "discarded";
/** ≥ 4.0 apply · 3.5 ≤ s < 4.0 review · < 3.5 discarded (D2). */
export const route = (total: number): Route => (total >= 4 ? "apply" : total >= 3.5 ? "review" : "discarded");

/** One validation retry, then give up (PLAN.md §5 stage 6). `call` gets the previous error to feed back. */
export async function withOneRetry<T>(call: (previousError?: string) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let error: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ok: true, value: await call(error) };
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return { ok: false, error: error! };
}
