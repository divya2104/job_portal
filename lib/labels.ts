// Human-readable labels shared by server and client components.

export const REASONS: Record<string, string> = {
  title_mismatch: "Title doesn't match your target roles",
  location_mismatch: "Location doesn't match your preferences",
  too_old: "Posted more than 45 days ago",
  exp_above_range: "Asks for more experience than your range",
  exp_below_range: "Experience cap is below your range",
  no_sponsorship: "States no visa sponsorship",
  salary_below_floor: "Stated salary is below your minimum",
  salary_currency_mismatch: "Salary in a different currency",
  expired: "Posting is closed",
  liveness_uncertain: "Couldn't confirm the posting is open (will retry)",
  unreachable: "Couldn't confirm the posting is open after 3 tries",
  score_below_3_5: "Scored below 3.5",
  eval_failed: "Scoring failed (will retry next run)",
};
export const reasonLabel = (code: string | null) =>
  !code ? "" : code.startsWith("duplicate_of:") ? "Duplicate of a posting you already have" : REASONS[code] ?? code;

export const CRITERIA: [string, string][] = [
  ["skills_match", "Skills"], ["seniority_fit", "Seniority"], ["domain_fit", "Domain"], ["location_workmode", "Location"], ["compensation_fit", "Pay"],
];
