import { describe, expect, it } from "vitest";
import { extractExperience, hardFilter, keywordHit, type FilterJob, type FilterProfile } from "@/lib/filters";

const profile: FilterProfile = {
  title_keywords: { positive: ["Product Manager", "Product Owner", "APM"], negative: ["Engineer", "Director", "word:Intern"] },
  cities: ["Bengaluru", "Mumbai"], accepts_remote: true, accepts_hybrid: true,
  exp_min: 1, exp_max: 4, pay_currency: "INR", pay_min_annual: 2800000, needs_sponsorship: false,
};
const job = (over: Partial<FilterJob> = {}): FilterJob => ({
  title: "Product Manager", location: "Bengaluru, India", work_mode: null, posted_at: null, jd_text: "Build lending products.", salary: null, ...over,
});
const NOW = new Date("2026-10-29T00:00:00Z");
const reason = (j: FilterJob, p = profile) => {
  const r = hardFilter(j, p, NOW);
  return r.pass ? "pass" : r.reason_code;
};

describe("title", () => {
  it("passes a positive match and rejects a negative word", () => {
    expect(reason(job())).toBe("pass");
    expect(reason(job({ title: "Product Manager, Engineering Platform" }))).toBe("pass"); // exclusions are whole-word
    expect(reason(job({ title: "Software Engineer" }))).toBe("title_mismatch");
    expect(reason(job({ title: "Director, Product Management" }))).toBe("title_mismatch");
  });
  it("short and word: keywords match whole words only", () => {
    expect(keywordHit("APM - Payments", "APM")).toBe(true);
    expect(keywordHit("RAPMOD analyst", "APM")).toBe(false);
    expect(keywordHit("Internal Tools PM", "word:Intern")).toBe(false);
    expect(keywordHit("Product Intern", "word:Intern")).toBe(true);
  });
  it("keeps the discard evidence", () => {
    expect(hardFilter(job({ title: "Data Scientist" }), profile, NOW)).toEqual({ pass: false, reason_code: "title_mismatch", evidence: "Data Scientist" });
  });
});

describe("location", () => {
  it("passes empty location (unknown passes)", () => expect(reason(job({ location: null }))).toBe("pass"));
  it("matches city aliases", () => expect(reason(job({ location: "Bangalore" }))).toBe("pass"));
  it("passes remote when accepted, rejects when not", () => {
    expect(reason(job({ location: "Remote - India" }))).toBe("pass");
    expect(reason(job({ location: "Remote - India" }), { ...profile, accepts_remote: false })).toBe("location_mismatch");
  });
  it("hybrid in a preferred city depends on accepts_hybrid", () => {
    expect(reason(job({ location: "Mumbai", work_mode: "hybrid" }), { ...profile, accepts_hybrid: false })).toBe("location_mismatch");
    expect(reason(job({ location: "Mumbai", work_mode: "hybrid" }))).toBe("pass");
  });
  it("rejects other cities", () => expect(reason(job({ location: "San Francisco, CA" }))).toBe("location_mismatch"));
});

describe("posting age", () => {
  it("rejects only when a known date is older than 45 days", () => {
    expect(reason(job({ posted_at: "2026-10-01T00:00:00Z" }))).toBe("pass");
    expect(reason(job({ posted_at: "2026-08-01T00:00:00Z" }))).toBe("too_old");
    expect(reason(job({ posted_at: null }))).toBe("pass");
  });
});

describe("experience", () => {
  it("extracts ranges, N+ and minimum phrasing with the quoted sentence", () => {
    expect(extractExperience("You have 3-5 years of experience in product.")).toMatchObject({ min: 3, max: 5 });
    expect(extractExperience("Requirements:\n• 8+ years of product management experience")).toMatchObject({ min: 8, max: null, quote: expect.stringContaining("8+ years of product management experience") });
    expect(extractExperience("Minimum of 2 years experience with B2B SaaS.")).toMatchObject({ min: 2, max: null });
    expect(extractExperience("We were founded 10 years ago.")).toBeNull(); // no "experience" in sentence
  });
  it("discards above and below the user's range, passes unknown", () => {
    expect(reason(job({ jd_text: "8+ years of product management experience required." }))).toBe("exp_above_range");
    expect(reason(job({ jd_text: "0-0 years experience, fresh graduates." }))).toBe("exp_below_range");
    expect(reason(job({ jd_text: "3-5 years of experience." }))).toBe("pass");
    expect(reason(job({ jd_text: "Great team culture." }))).toBe("pass");
  });
});

describe("sponsorship", () => {
  const jd = "We are unable to sponsor visas for this role.";
  it("only applies when the user needs sponsorship", () => {
    expect(reason(job({ jd_text: jd }))).toBe("pass");
    expect(hardFilter(job({ jd_text: jd }), { ...profile, needs_sponsorship: true }, NOW)).toMatchObject({ reason_code: "no_sponsorship", evidence: jd });
  });
});

describe("salary", () => {
  it("only applies to structured salary", () => {
    expect(reason(job({ salary: null }))).toBe("pass");
    expect(reason(job({ salary: { min: 1500000, max: 2000000, currency: "INR" } }))).toBe("salary_below_floor");
    expect(reason(job({ salary: { min: 2500000, max: 3500000, currency: "INR" } }))).toBe("pass");
    expect(reason(job({ salary: { min: 100000, max: 150000, currency: "USD" } }))).toBe("salary_currency_mismatch");
  });
});
