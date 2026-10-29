// Deterministic hard filter (PLAN.md §7). No LLM. Unknown data passes; a discard carries evidence.

export type FilterProfile = {
  title_keywords: { positive: string[]; negative: string[] };
  cities: string[];
  accepts_remote: boolean;
  accepts_hybrid: boolean;
  exp_min: number | null;
  exp_max: number | null;
  pay_currency: string | null;
  pay_min_annual: number | null;
  needs_sponsorship: boolean;
};

export type FilterJob = {
  title: string;
  location: string | null;
  work_mode: string | null; // remote | hybrid | onsite | null
  posted_at: string | null;
  jd_text: string | null;
  salary: { min?: number | null; max?: number | null; currency?: string | null } | null;
};

export type FilterResult = { pass: true } | { pass: false; reason_code: string; evidence: string };

const MAX_AGE_DAYS = 45;

/** 2–3 letter keywords ("AI", "PM", "VP") and `word:` keywords match whole words only. */
export function keywordHit(text: string, keyword: string): boolean {
  const whole = keyword.startsWith("word:");
  const k = (whole ? keyword.slice(5) : keyword).trim().toLowerCase();
  if (!k) return false;
  const t = text.toLowerCase();
  if (whole || k.length <= 3) return new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(t);
  return t.includes(k);
}

/** Exclusions match whole words only, so "Engineer" never rejects "Product Manager, Engineering Platform". */
export function titleMatches(title: string, kw: FilterProfile["title_keywords"]): boolean {
  return kw.positive.some((k) => keywordHit(title, k)) && !kw.negative.some((k) => keywordHit(title, k.startsWith("word:") ? k : `word:${k}`));
}

const CITY_ALIASES: string[][] = [
  ["bengaluru", "bangalore"], ["mumbai", "bombay"], ["gurugram", "gurgaon"], ["chennai", "madras"],
  ["kolkata", "calcutta"], ["new delhi", "delhi", "ncr"], ["pune"], ["hyderabad"], ["noida"],
];
const cityNames = (city: string) => CITY_ALIASES.find((g) => g.includes(city.toLowerCase())) ?? [city.toLowerCase()];
const REMOTE = /\b(remote|work from home|wfh|pan[- ]india|anywhere)\b/i;

export function locationOk(job: FilterJob, p: FilterProfile): boolean {
  const loc = (job.location ?? "").trim();
  if (!loc && !job.work_mode) return true; // unknown passes
  const remote = job.work_mode === "remote" || REMOTE.test(loc);
  const hybrid = job.work_mode === "hybrid" || /\bhybrid\b/i.test(loc);
  const inCity = p.cities.some((c) => cityNames(c).some((n) => loc.toLowerCase().includes(n)));
  if (remote && p.accepts_remote) return true;
  if (inCity) return hybrid ? p.accepts_hybrid : true;
  return false;
}

/** First sentence stating a years-of-experience requirement → {min, max, quote}. */
export function extractExperience(jd: string | null): { min: number; max: number | null; quote: string } | null {
  if (!jd) return null;
  const sentences = jd.split(/(?<=[.!?;•\n])\s+|\n/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (!/\byears?\b|\byrs?\b/i.test(s) || !/experience|exp\b|experienced/i.test(s)) continue;
    let m = s.match(/(\d{1,2})\s*\+?\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i);
    if (m) return { min: +m[1], max: +m[2], quote: s };
    m = s.match(/(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i) ?? s.match(/(\d{1,2})\s*\+\s*(?:years?|yrs?)/i)
      ?? s.match(/(\d{1,2})\s*(?:years?|yrs?)/i);
    if (m && +m[1] <= 30) return { min: +m[1], max: null, quote: s };
  }
  return null;
}

const NO_SPONSOR = /(no|not|unable to|cannot|can't|won't|will not|do not|does not)\s+(provide\s+|offer\s+)?(visa\s+)?sponsor|without (the need for )?(visa )?sponsorship|sponsorship (is )?not (available|provided|offered)/i;

export function hardFilter(job: FilterJob, p: FilterProfile, now = new Date()): FilterResult {
  if (!titleMatches(job.title, p.title_keywords)) return { pass: false, reason_code: "title_mismatch", evidence: job.title };

  if (!locationOk(job, p)) return { pass: false, reason_code: "location_mismatch", evidence: [job.location, job.work_mode].filter(Boolean).join(" · ") };

  if (job.posted_at) {
    const days = (now.getTime() - new Date(job.posted_at).getTime()) / 86_400_000;
    if (days > MAX_AGE_DAYS) return { pass: false, reason_code: "too_old", evidence: `Posted ${job.posted_at.slice(0, 10)} (${Math.floor(days)} days ago)` };
  }

  const exp = extractExperience(job.jd_text);
  if (exp && p.exp_max !== null && exp.min > p.exp_max) return { pass: false, reason_code: "exp_above_range", evidence: exp.quote };
  if (exp && exp.max !== null && p.exp_min !== null && exp.max < p.exp_min) return { pass: false, reason_code: "exp_below_range", evidence: exp.quote };

  if (p.needs_sponsorship && job.jd_text) {
    const s = job.jd_text.split(/(?<=[.!?])\s+|\n/).find((x) => NO_SPONSOR.test(x));
    if (s) return { pass: false, reason_code: "no_sponsorship", evidence: s.trim() };
  }

  const sal = job.salary;
  if (sal && (sal.min != null || sal.max != null) && p.pay_currency) {
    if (sal.currency && sal.currency.toUpperCase() !== p.pay_currency.toUpperCase())
      return { pass: false, reason_code: "salary_currency_mismatch", evidence: `${sal.currency} ${sal.min ?? ""}–${sal.max ?? ""}` };
    const top = sal.max ?? sal.min!;
    if (p.pay_min_annual != null && top < p.pay_min_annual)
      return { pass: false, reason_code: "salary_below_floor", evidence: `${sal.currency ?? ""} ${sal.min ?? ""}–${sal.max ?? ""}`.trim() };
  }
  return { pass: true };
}
