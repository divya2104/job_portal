import type { ParsedCv } from "./cv.ts";

const ALIASES: [RegExp, string][] = [
  [/^(first|last|full|legal|preferred)?\s*name$/, "full_name"],
  [/e-?mail/, "email"],
  [/phone|mobile/, "phone"],
  [/linkedin/, "linkedin_url"],
  [/website|portfolio|github/, "portfolio_url"],
  [/resume|\bcv\b/, "__cv"], // satisfied by the attached CV
  [/current.*(ctc|salary|compensation)/, "current_ctc"],
  [/expected.*(ctc|salary|compensation)|salary expectation/, "expected_ctc"],
  [/notice period|earliest start|start date/, "notice_period"],
  [/relocat/, "willing_to_relocate"],
  [/sponsor/, "needs_sponsorship"],
  [/authori[sz]ed|work permit|right to work/, "work_authorization"],
  [/how did you hear/, "how_did_you_hear"],
  [/gender/, "gender"],
  [/disability|veteran/, "eeo_disability_veteran"],
  [/years.*experience|experience.*years/, "total_experience_years"],
  [/^(current )?(city|location)/, "current_city"],
];

/** Required form questions with no saved answer (the attached CV covers resume fields). Never invents answers. */
export function missingAnswers(questions: { label: string; required: boolean }[], answered: Set<string>) {
  return questions.filter((q) => q.required).map((q) => ({ label: q.label, key: questionKey(q.label) }))
    .filter((q) => q.key !== "__cv" && !answered.has(q.key));
}

/** answer_bank key for a form label: a known alias, else the normalised label (how learned answers are stored). */
export function questionKey(label: string): string {
  const l = label.toLowerCase().replace(/\*/g, "").trim();
  return ALIASES.find(([re]) => re.test(l))?.[1] ?? l.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80);
}

type Profile = { cities: string[]; authorized_in: string[]; needs_sponsorship: boolean; pay_currency: string | null; pay_min_annual: number | null };

/** Common application-form questions asked once at onboarding (PLAN.md §4, step 6). */
export const COMMON_QUESTIONS: { key: string; label: string; required?: boolean; prefill?: (cv: ParsedCv | null, p: Profile) => string | null | undefined }[] = [
  { key: "full_name", label: "Full legal name", required: true, prefill: (cv) => cv?.name },
  { key: "email", label: "Email", required: true, prefill: (cv) => cv?.email },
  { key: "phone", label: "Phone (with country code)", required: true, prefill: (cv) => cv?.phone },
  { key: "current_city", label: "Current city", prefill: (_, p) => p.cities[0] },
  { key: "linkedin_url", label: "LinkedIn URL", prefill: (cv) => cv?.linkedin },
  { key: "portfolio_url", label: "Portfolio / GitHub / website" },
  { key: "total_experience_years", label: "Total years of experience", prefill: (cv) => (cv ? String(cv.total_years) : null) },
  { key: "current_ctc", label: "Current annual compensation (CTC)" },
  { key: "expected_ctc", label: "Expected annual compensation", prefill: (_, p) => (p.pay_min_annual ? `${p.pay_currency ?? ""} ${p.pay_min_annual}`.trim() : null) },
  { key: "notice_period", label: "Notice period / earliest start date" },
  { key: "willing_to_relocate", label: "Willing to relocate? (Yes / No)" },
  { key: "work_authorization", label: "Countries you're authorised to work in", prefill: (_, p) => p.authorized_in.join(", ") },
  { key: "needs_sponsorship", label: "Will you need visa sponsorship? (Yes / No)", prefill: (_, p) => (p.needs_sponsorship ? "Yes" : "No") },
  { key: "gender", label: "Gender (optional)", prefill: () => "Prefer not to say" },
  { key: "eeo_disability_veteran", label: "Disability / veteran status (optional)", prefill: () => "Prefer not to say" },
  { key: "how_did_you_hear", label: "How did you hear about us?", prefill: () => "Company website" },
];
