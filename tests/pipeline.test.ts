// Integration: two users, one fixture careers board, mocked network + scorer, real local database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { admin, dropUser, evalFixture, makeUser } from "./helpers";
import { createRun, runBatch, runUser } from "@/worker/pipeline";
import { settings as httpSettings } from "@/worker/http";

const board = JSON.parse(readFileSync("tests/fixtures/greenhouse-board.json", "utf8"));
const tag = randomUUID().slice(0, 8);
const realFetch = globalThis.fetch;
const calls: string[] = [];

// Scores by Greenhouse job id (per user where it matters); 109 always returns invalid output.
const SCORES: Record<string, number | Record<string, number>> = { "101": 4.2, "104": 3.7, "106": { A: 3.2, B: 4.5 }, "108": 4.0 };
const scorerCalls: { user: string; job: string; prompt: string }[] = [];
const score = vi.fn(async (c: any, j: any) => {
  const user = c.cv_text.includes("CV-OF-A") ? "A" : "B";
  scorerCalls.push({ user, job: j.title, prompt: JSON.stringify(c) });
  const id = j.source_url.split("/").pop()!.split("?")[0];
  const s = SCORES[id];
  if (s === undefined) throw new Error("output did not match the schema");
  const v = typeof s === "number" ? s : s[user];
  return evalFixture([v, v, v, v, null]);
});

let A: Awaited<ReturnType<typeof makeUser>>, B: Awaited<ReturnType<typeof makeUser>>;
let goodSource: string, brokenSource: string, originalThrottle: number;

async function onboard(u: typeof A, marker: string, profile: object, sources: string[]) {
  await admin.from("profiles").update({ onboarded_at: new Date().toISOString(), ...profile }).eq("user_id", u.id);
  await admin.from("cvs").insert({ user_id: u.id, storage_path: `${u.id}/cv.pdf`, file_name: "cv.pdf", parsed: { total_years: 3 }, text: `${marker} private CV text`, is_active: true, confirmed_at: new Date().toISOString() });
  await admin.from("saved_companies").insert(sources.map((source_id) => ({ user_id: u.id, source_id })));
}

beforeAll(async () => {
  originalThrottle = (await admin.from("app_settings").select("throttle_ms_per_domain").single()).data!.throttle_ms_per_domain;
  await admin.from("app_settings").update({ throttle_ms_per_domain: 0 }).eq("id", true);
  httpSettings.backoffMs = [0, 0, 0];

  goodSource = (await admin.from("sources").insert({ name: "FixtureCo", careers_url: `https://job-boards.greenhouse.io/fixtureco-${tag}`, provider: "greenhouse", provider_ref: "fixtureco" }).select("id").single()).data!.id;
  brokenSource = (await admin.from("sources").insert({ name: "BrokenCo", careers_url: `https://jobs.lever.co/broken-${tag}`, provider: "lever", provider_ref: `broken-${tag}` }).select("id").single()).data!.id;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL!)) return realFetch(input, init);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://boards-api.greenhouse.io/v1/boards/fixtureco/jobs?content=true") return json(board);
    if (url.includes("/jobs/101?questions=true")) return json({ questions: [{ label: "First Name", required: true }, { label: "Email", required: true }, { label: "Resume/CV", required: true }, { label: "Why do you want to join FixtureCo?", required: true }] });
    if (url.includes("?questions=true")) return json({ questions: [{ label: "First Name", required: true }, { label: "Email", required: true }] });
    if (url.includes("api.lever.co")) return json({ error: "boom" }, 500);
    return json({}, 404);
  });

  [A, B] = await Promise.all([makeUser("pipe-a"), makeUser("pipe-b")]);
  const base = { accepts_hybrid: true, pay_currency: "INR", pay_min_annual: null, needs_sponsorship: false, authorized_in: ["India"] };
  await onboard(A, "CV-OF-A", { ...base, target_titles: ["Product Manager"], title_keywords: { positive: ["Product Manager", "Product Owner", "APM"], negative: ["Engineer", "Director"] },
    cities: ["Bengaluru", "Mumbai"], accepts_remote: true, exp_min: 1, exp_max: 4 }, [goodSource, brokenSource]);
  await onboard(B, "CV-OF-B", { ...base, target_titles: ["Product Owner"], title_keywords: { positive: ["Product Owner"], negative: [] },
    cities: ["Mumbai"], accepts_remote: false, exp_min: 0, exp_max: 10 }, [goodSource]);
  await admin.from("answer_bank").insert([A.id, B.id].flatMap((user_id) => [
    { user_id, question_key: "full_name", question_label: "Full legal name", answer: "Test", source: "onboarding" },
    { user_id, question_key: "email", question_label: "Email", answer: "t@test.local", source: "onboarding" },
  ]));

  await runBatch(admin, { score }, [A.id, B.id]);
}, 120000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await admin.from("app_settings").update({ throttle_ms_per_domain: originalThrottle }).eq("id", true);
  await Promise.all([A, B].filter(Boolean).map((u) => dropUser(u.id)));
  await admin.from("jobs").delete().like("url_key", "job-boards.greenhouse.io/fixtureco/%");
  await admin.from("sources").delete().in("id", [goodSource, brokenSource]);
});

const jobsOf = async (userId: string): Promise<Record<string, any>> => {
  const { data } = await admin.from("user_jobs").select("status, reason_code, evidence, total, jobs(external_id, title)").eq("user_id", userId);
  return Object.fromEntries((data ?? []).map((r: any) => [r.jobs.external_id, r]));
};

describe("scheduled batch over a fixture careers page", () => {
  it("fetches the shared board once for both users", () => {
    expect(calls.filter((c) => c.endsWith("/boards/fixtureco/jobs?content=true"))).toHaveLength(1);
  });

  it("routes every job for user A with a stored reason or score", async () => {
    const j = await jobsOf(A.id);
    expect(j["101"]).toMatchObject({ status: "needs_input", total: 4.2 }); // apply → custom question unanswered
    expect(j["102"]).toMatchObject({ status: "filtered_out", reason_code: "exp_above_range", evidence: expect.stringContaining("8+ years") });
    expect(j["103"]).toBeUndefined(); // engineer title never matched discovery
    expect(j["104"]).toMatchObject({ status: "review", total: 3.7 });
    expect(j["105"]).toMatchObject({ status: "filtered_out", reason_code: "location_mismatch", evidence: "San Francisco, CA" });
    expect(j["106"]).toMatchObject({ status: "discarded", total: 3.2, reason_code: "score_below_3_5" });
    expect(j["107"]).toMatchObject({ status: "duplicate", reason_code: expect.stringMatching(/^duplicate_of:/) });
    expect(j["108"]).toMatchObject({ status: "ready_to_submit", total: 4 }); // 4.00 → apply; questions all answered
    expect(j["109"]).toMatchObject({ status: "eval_failed", reason_code: "eval_failed" }); // different req id → not a duplicate of 108
  });

  it("stores the unanswered question and never invents an answer", async () => {
    const { data } = await admin.from("user_jobs").select("reason_text, jobs!inner(external_id)").eq("user_id", A.id).eq("jobs.external_id", "101").single();
    expect(data!.reason_text).toBe("Answers needed: Why do you want to join FixtureCo?");
    const { data: bank } = await admin.from("answer_bank").select("question_key").eq("user_id", A.id);
    expect(bank).toHaveLength(2);
  });

  it("no silent drops: every discovered posting has a row", async () => {
    const { data: run } = await admin.from("runs").select("counts, status").eq("user_id", A.id).eq("trigger", "schedule").single();
    const { count } = await admin.from("user_jobs").select("id", { count: "exact", head: true }).eq("user_id", A.id);
    expect(run!.counts.discovered).toBe(8);
    expect(count).toBe(8);
  });

  it("a failing source is logged and skipped without killing the run", async () => {
    const { data: rs } = await admin.from("run_sources").select("source_id, status, error").eq("user_id", A.id);
    expect(rs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: brokenSource, status: "failed", error: expect.stringContaining("500") }),
      expect.objectContaining({ source_id: goodSource, status: "ok" }),
    ]));
    const { data: run } = await admin.from("runs").select("status").eq("user_id", A.id).single();
    expect(run!.status).toBe("completed_with_errors");
  });

  it("user B gets its own evaluation of the same posting", async () => {
    const j = await jobsOf(B.id);
    expect(Object.keys(j)).toEqual(["106"]);
    expect(j["106"]).toMatchObject({ status: "ready_to_submit", total: 4.5 });
  });
});

describe("cross-user isolation in the pipeline", () => {
  it("each scoring call carries only that user's CV", () => {
    expect(scorerCalls.length).toBeGreaterThan(0);
    for (const c of scorerCalls) {
      expect(c.prompt).toContain(`CV-OF-${c.user}`);
      expect(c.prompt).not.toContain(`CV-OF-${c.user === "A" ? "B" : "A"}`);
    }
    expect(scorerCalls.filter((c) => c.user === "B").map((c) => c.job)).toEqual(["Product Owner"]);
  });

  it("events and runs are tagged with the right user only", async () => {
    for (const u of [A, B]) {
      const { data: runs } = await admin.from("runs").select("id").eq("user_id", u.id);
      const { data: ev } = await admin.from("events").select("user_id, run_id").in("run_id", runs!.map((r) => r.id));
      expect(ev!.length).toBeGreaterThan(0);
      expect(new Set(ev!.map((e) => e.user_id))).toEqual(new Set([u.id]));
    }
  });

  it("through RLS, B sees none of A's jobs or events", async () => {
    expect((await B.db.from("user_jobs").select("id").eq("user_id", A.id)).data).toEqual([]);
    expect((await B.db.from("events").select("id").eq("user_id", A.id)).data).toEqual([]);
    expect((await B.db.from("user_jobs").select("id")).data).toHaveLength(1);
  });
});

describe("dedupe across runs", () => {
  it("a second run skips everything already seen; only eval_failed is retried", async () => {
    scorerCalls.length = 0;
    const runId = await createRun(admin, A.id, "adhoc", { url: "https://job-boards.greenhouse.io/fixtureco" });
    const counts = await runUser(admin, runId, { score });
    expect(counts.discovered ?? 0).toBe(0);
    expect(counts.seen).toBe(8);
    expect(scorerCalls.map((c) => c.job)).toEqual(["Product Manager, Payments", "Product Manager, Payments"]); // 109 retried once more
  });
});
