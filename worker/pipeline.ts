// Per-user pipeline (PLAN.md §5): discover → extract → liveness → dedupe → hard filter → evaluate → route → prepare.
// Every stage emits events tagged with user_id + run_id. A failing source never fails the run.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hardFilter, titleMatches, extractExperience, type FilterProfile } from "../lib/filters.ts";
import { computeTotal, route, withOneRetry } from "../lib/scoring.ts";
import { normTitle, urlKey } from "../lib/text.ts";
import { missingAnswers } from "../lib/questions.ts";
import { BlockedError, detectSource, NOT_A_POSTING, PROVIDERS, RobotsError, type Ctx, type Posting, type Source } from "./providers.ts";
import { HttpError, httpJson, settings as httpSettings } from "./http.ts";
import { costUsd, scoreJob, type Candidate, type Usage } from "./llm.ts";

export type Deps = { score: typeof scoreJob };
const defaultDeps: Deps = { score: scoreJob };

const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

// Rows with these outcomes are "seen": a later run skips them (D7: title/location/age/exp rejections carry no weight).
const REFILTERABLE = ["title_mismatch", "location_mismatch", "too_old", "exp_above_range", "exp_below_range"];
const RETRYABLE = ["extract_failed", "liveness_uncertain"];
const MAX_UNCERTAIN = 3;

/** Shared across the users of one scheduled batch so each source is fetched once (PLAN.md §8). */
export class Shared {
  listings = new Map<string, Promise<Posting[]>>();
  details = new Map<string, Promise<Posting>>();
  sharers = new Map<string, number>(); // source_id → users in this batch tracking it
  batchId: string | null;
  searchTerms: string[];
  constructor(batchId: string | null, searchTerms: string[] = []) {
    this.batchId = batchId;
    this.searchTerms = searchTerms;
  }
}

class RunLog {
  counts: Record<string, number> = {};
  failures = 0;
  db: SupabaseClient;
  userId: string;
  runId: string;
  constructor(db: SupabaseClient, userId: string, runId: string) {
    this.db = db;
    this.userId = userId;
    this.runId = runId;
  }
  async emit(stage: string, kind: string, payload: object = {}, userJobId: string | null = null, count?: string) {
    if (count) this.counts[count] = (this.counts[count] ?? 0) + 1;
    must(await this.db.from("events").insert({ user_id: this.userId, run_id: this.runId, user_job_id: userJobId, stage, kind, payload }));
    if (count) must(await this.db.from("runs").update({ counts: this.counts }).eq("id", this.runId));
  }
}

async function settingsRow(db: SupabaseClient) {
  return must(await db.from("app_settings").select("*").single()) as any;
}

const monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
async function monthSpend(db: SupabaseClient, kind: "llm" | "firecrawl") {
  const q = db.from("usage_ledger").select("units, cost_usd").gte("created_at", monthStart());
  const rows = must(await (kind === "llm" ? q.in("kind", ["llm_input_tokens", "llm_output_tokens"]) : q.eq("kind", "firecrawl_credits"))) as any[];
  return rows.reduce((s, r) => s + Number(kind === "llm" ? r.cost_usd : r.units), 0);
}

/** Mark runs stuck in `running` for > 2 h as failed (worker crashed or timed out). */
export async function reapStale(db: SupabaseClient) {
  const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
  must(await db.from("runs").update({ status: "failed", error: "worker_timeout", finished_at: new Date().toISOString() })
    .eq("status", "running").lt("started_at", cutoff));
}

export async function createRun(db: SupabaseClient, userId: string, trigger: "schedule" | "adhoc" | "rescore", opts: { batchId?: string; url?: string } = {}) {
  return (must(await db.from("runs").insert({ user_id: userId, trigger, batch_id: opts.batchId ?? null, adhoc_url: opts.url ?? null }).select("id").single()) as any).id as string;
}

/** Scheduled batch: every onboarded user with ≥1 active saved company. */
export async function runBatch(db: SupabaseClient, deps: Deps = defaultDeps, onlyUserIds?: string[]) {
  await reapStale(db);
  const batchId = randomUUID();
  let profiles = must(await db.from("profiles").select("user_id, email, target_titles, onboarded_at").not("onboarded_at", "is", null)) as any[];
  if (onlyUserIds) profiles = profiles.filter((p) => onlyUserIds.includes(p.user_id));
  const saved = must(await db.from("saved_companies").select("user_id, source_id").eq("active", true)) as any[];
  const shared = new Shared(batchId, [...new Set(profiles.flatMap((p) => p.target_titles))]);
  for (const r of saved) shared.sharers.set(r.source_id, (shared.sharers.get(r.source_id) ?? 0) + 1);

  const runIds: string[] = [];
  for (const p of profiles) {
    if (!saved.some((r) => r.user_id === p.user_id)) continue;
    const runId = await createRun(db, p.user_id, "schedule", { batchId });
    runIds.push(runId);
    await runUser(db, runId, deps, shared);
  }
  return { batchId, runIds };
}

/** Run one queued run for its user. Never throws for a single source/job failure. */
export async function runUser(db: SupabaseClient, runId: string, deps: Deps = defaultDeps, shared?: Shared) {
  const claimed = must(await db.from("runs").update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", runId).eq("status", "queued").select("*")) as any[];
  if (!claimed.length) throw new Error(`run ${runId} is not queued`);
  const run = claimed[0];
  const log = new RunLog(db, run.user_id, runId);
  try {
    await execute(db, run, log, deps, shared);
    const status = log.failures ? "completed_with_errors" : "completed";
    await log.emit("run", "completed", { counts: log.counts });
    must(await db.from("runs").update({ status, counts: log.counts, finished_at: new Date().toISOString() }).eq("id", runId));
  } catch (e) {
    const error = (e as Error).message;
    await log.emit("run", "failed", { error }).catch(() => {});
    await db.from("runs").update({ status: "failed", error, counts: log.counts, finished_at: new Date().toISOString() }).eq("id", runId);
  }
  return log.counts;
}

async function execute(db: SupabaseClient, run: any, log: RunLog, deps: Deps, shared = new Shared(null)) {
  const s = await settingsRow(db);
  httpSettings.throttleMs = s.throttle_ms_per_domain;
  const profile = must(await db.from("profiles").select("*").eq("user_id", run.user_id).single()) as any;
  const cv = (must(await db.from("cvs").select("text, parsed").eq("user_id", run.user_id).eq("is_active", true).not("confirmed_at", "is", null).maybeSingle())) as any;
  if (!cv) throw new Error("No confirmed CV; finish onboarding first.");
  const limits = (must(await db.from("user_limits").select("*").eq("user_id", run.user_id).maybeSingle()) as any) ?? {};
  const cap = (k: string) => limits[k] ?? s[k];

  const since = new Date(); since.setHours(0, 0, 0, 0);
  const today = must(await db.from("runs").select("id", { count: "exact" }).eq("user_id", run.user_id).gte("created_at", since.toISOString()).neq("id", run.id)) as any[];
  if (today.length >= cap("max_runs_per_day")) throw new Error(`Daily run limit (${cap("max_runs_per_day")}) reached.`);

  await log.emit("run", "started", { trigger: run.trigger, adhoc_url: run.adhoc_url });
  const ctx: Ctx = {
    searchTerms: shared.searchTerms.length ? shared.searchTerms : profile.target_titles,
    maxPages: s.firecrawl_max_pages,
    credits: { firecrawl: 0 },
    usage: (u) => recordLlm(db, log, u),
  };

  if (run.trigger !== "rescore") {
    for (const src of await sourcesFor(db, run, profile, cap("max_sources_per_run"), log)) {
      await processSource(db, src, profile, ctx, log, shared);
    }
  } else {
    // Re-score stale open jobs and re-filter title/location/exp/age rejections (PLAN.md §3).
    const stale = must(await db.from("user_jobs").select("id, status, reason_code, jobs(*)").eq("user_id", run.user_id).eq("stale", true)) as any[];
    for (const uj of stale) await filterInto(db, log, profile, uj.jobs, uj.id, uj.status);
  }
  await evaluateStage(db, run, profile, cv, log, deps, cap("max_evals_per_run"), s.llm_monthly_budget_usd);
}

async function sourcesFor(db: SupabaseClient, run: any, profile: any, maxSources: number, log: RunLog): Promise<(Source & { postingId?: string | null })[]> {
  if (run.adhoc_url) {
    const d = detectSource(run.adhoc_url);
    // Reuse an existing source (e.g. a starter company) untouched; only insert unknown ones.
    await db.from("sources").upsert({ name: d.name, careers_url: d.careers_url, provider: d.provider, provider_ref: d.provider_ref }, { onConflict: "careers_url", ignoreDuplicates: true });
    const row = must(await db.from("sources").select("*").eq("careers_url", d.careers_url).single()) as any;
    return [{ ...row, careers_url: d.provider === "firecrawl" ? run.adhoc_url : row.careers_url, postingId: d.postingId }];
  }
  const rows = must(await db.from("saved_companies").select("sources(*)").eq("user_id", profile.user_id).eq("active", true)) as any[];
  const all = rows.map((r) => r.sources).filter((x) => x && !(x.blocked_until && new Date(x.blocked_until) > new Date()));
  if (all.length > maxSources) await log.emit("run", "quota_trimmed", { sources: all.length, max_sources_per_run: maxSources });
  return all.slice(0, maxSources);
}

async function processSource(db: SupabaseClient, src: Source & { postingId?: string | null }, profile: any, ctx: Ctx, log: RunLog, shared: Shared) {
  const runSource = (status: string, extra: object = {}) =>
    db.from("run_sources").upsert({ run_id: log.runId, source_id: src.id, user_id: log.userId, status, ...extra });
  const provider = PROVIDERS[src.provider];
  const creditsBefore = ctx.credits.firecrawl;
  try {
    if (src.provider === "firecrawl") {
      const s = await settingsRow(db);
      if ((await monthSpend(db, "firecrawl")) >= s.firecrawl_monthly_credit_budget) {
        await runSource("skipped_quota", { error: "monthly Firecrawl credit budget reached" });
        await log.emit("discover", "source_skipped", { source: src.name, reason: "firecrawl_budget" });
        return;
      }
    }

    let postings: Posting[];
    if (src.provider === "firecrawl" && src.postingId === null) {
      // Pasted non-ATS URL: try it as a single posting; if it isn't one, treat it as a careers page.
      const single = await provider.detail(src, blankPosting(src), ctx);
      postings = single.title === NOT_A_POSTING ? await provider.list(src, ctx) : [single];
    } else {
      let listing = shared.listings.get(src.id);
      const fetchedNow = !listing;
      if (!listing) shared.listings.set(src.id, (listing = provider.list(src, ctx)));
      postings = await listing;
      if (fetchedNow && shared.batchId)
        await db.from("source_fetches").upsert({ source_id: src.id, batch_id: shared.batchId, status: "ok", credits_used: ctx.credits.firecrawl - creditsBefore });
    }
    if (src.postingId) postings = postings.filter((p) => p.external_id === src.postingId || p.source_url.includes(src.postingId!));
    const matched = postings.filter((p) => !p.title || titleMatches(p.title, profile.title_keywords));
    await log.emit("discover", "source_ok", { source: src.name, found: postings.length, matched: matched.length });

    for (const p of matched) {
      try {
        await processPosting(db, src, p, profile, ctx, log, shared);
      } catch (e) {
        log.failures++;
        await log.emit("extract", "failed", { source: src.name, url: p.source_url, error: (e as Error).message }, null, "failed");
      }
    }
    await runSource("ok", { jobs_found: matched.length });
  } catch (e) {
    log.failures++;
    const err = e as Error;
    const status = e instanceof RobotsError ? "skipped_robots" : e instanceof BlockedError || (e instanceof HttpError && e.status === 403) ? "blocked" : "failed";
    if (status === "blocked") await db.from("sources").update({ blocked_until: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", src.id);
    await runSource(status, { error: err.message });
    await log.emit("discover", "source_failed", { source: src.name, status, error: err.message });
  } finally {
    const used = ctx.credits.firecrawl - creditsBefore;
    if (used) await recordCredits(db, log, used / Math.max(1, shared.sharers.get(src.id) ?? 1));
  }
}

const blankPosting = (src: Source): Posting => ({
  apply_url: src.careers_url, source_url: src.careers_url, external_id: null, requisition_id: null, company: src.name, title: "",
  location: null, work_mode: null, posted_at: null, jd_text: null, salary: null, liveness: "uncertain", needsDetail: true,
});

async function processPosting(db: SupabaseClient, src: Source, posting: Posting, profile: any, ctx: Ctx, log: RunLog, shared: Shared) {
  const key = urlKey(posting.source_url);

  // EXTRACT (cached across users by URL; Firecrawl pages reused for 24 h)
  let job = must(await db.from("jobs").select("*").eq("url_key", key).maybeSingle()) as any;
  const fresh = posting.needsDetail && job?.jd_text && job.fetched_at && Date.now() - Date.parse(job.fetched_at) < 86_400_000;
  if (!fresh) {
    let full = posting;
    if (posting.needsDetail) {
      let d = shared.details.get(key);
      if (!d) shared.details.set(key, (d = PROVIDERS[src.provider].detail(src, posting, ctx)));
      full = await d;
    }
    const exp = extractExperience(full.jd_text);
    job = must(await db.from("jobs").upsert({
      url_key: key, apply_url: full.apply_url, source_url: full.source_url, source_id: src.id, external_id: full.external_id,
      requisition_id: full.requisition_id, company: full.company, title: full.title || "(untitled)", title_norm: normTitle(full.title),
      location: full.location, work_mode: full.work_mode, exp_min: exp?.min ?? null, exp_max: exp?.max ?? null, exp_quote: exp?.quote ?? null,
      salary: full.salary, posted_at: full.posted_at, jd_text: full.jd_text, liveness: full.liveness,
      liveness_checked_at: new Date().toISOString(), fetched_at: new Date().toISOString(), fetch_batch_id: shared.batchId,
    }, { onConflict: "url_key" }).select("*").single());
    if (shared.batchId) {
      const f = (must(await db.from("source_fetches").select("job_ids").eq("source_id", src.id).eq("batch_id", shared.batchId).maybeSingle()) as any);
      if (f && !f.job_ids.includes(job.id)) await db.from("source_fetches").update({ job_ids: [...f.job_ids, job.id] }).eq("source_id", src.id).eq("batch_id", shared.batchId);
    }
  }

  // DEDUPE against this user's history
  const existing = must(await db.from("user_jobs").select("id, status, reason_code, profile_version").eq("user_id", log.userId).eq("job_id", job.id).maybeSingle()) as any;
  if (existing) {
    const refilter = existing.status === "filtered_out" && REFILTERABLE.includes(existing.reason_code) && existing.profile_version !== profile.profile_version;
    if (!refilter && !RETRYABLE.includes(existing.status)) {
      log.counts.seen = (log.counts.seen ?? 0) + 1;
      return;
    }
  }
  let ujId: string = existing?.id;
  const dup = existing ? null : await findDuplicate(db, log.userId, job);
  if (!existing) {
    const row = must(await db.from("user_jobs").insert({
      user_id: log.userId, job_id: job.id, first_run_id: log.runId, last_run_id: log.runId, profile_version: profile.profile_version,
      status: dup ? "duplicate" : "extracted", reason_code: dup ? `duplicate_of:${dup}` : null,
    }).select("id").single()) as any;
    ujId = row.id;
  }
  await log.emit("discover", "job", { title: job.title, company: job.company, url: job.apply_url }, ujId, "discovered");
  if (!existing) {
    if (dup) {
      await log.emit("dedupe", "duplicate", { duplicate_of: dup, title: job.title }, ujId, "duplicate");
      return;
    }
  }
  await log.emit("extract", "job", { title: job.title, company: job.company, location: job.location }, ujId, "extracted");

  // LIVENESS
  if (job.liveness === "expired") {
    await setStatus(db, ujId, { status: "expired", reason_code: "expired", reason_text: "Posting is closed or no longer available" });
    await log.emit("liveness", "expired", { title: job.title }, ujId, "expired");
    return;
  }
  if (job.liveness === "uncertain" || !job.jd_text) {
    const { count } = await db.from("events").select("id", { count: "exact", head: true }).eq("user_job_id", ujId).eq("kind", "uncertain");
    const giveUp = (count ?? 0) + 1 >= MAX_UNCERTAIN;
    await setStatus(db, ujId, { status: giveUp ? "unreachable" : "liveness_uncertain", reason_code: giveUp ? "unreachable" : "liveness_uncertain",
      reason_text: "Couldn't confirm the posting is open (login wall, bot check, or no description)" });
    await log.emit("liveness", "uncertain", { title: job.title, attempt: (count ?? 0) + 1 }, ujId, "uncertain");
    return;
  }
  await log.emit("liveness", "live", { title: job.title }, ujId, "live");

  // HARD FILTER
  await filterInto(db, log, profile, job, ujId, "extracted");
}

async function filterInto(db: SupabaseClient, log: RunLog, profile: FilterProfile & { profile_version: number }, job: any, ujId: string, from: string) {
  const r = hardFilter(job, profile);
  if (!r.pass) {
    await setStatus(db, ujId, { status: "filtered_out", reason_code: r.reason_code, evidence: r.evidence, reason_text: null, profile_version: profile.profile_version, stale: false });
    await log.emit("filter", "discarded", { title: job.title, from, reason_code: r.reason_code, evidence: r.evidence }, ujId, "filtered");
  } else {
    await setStatus(db, ujId, { status: "eval_pending", reason_code: null, evidence: null, profile_version: profile.profile_version });
    await log.emit("filter", "passed", { title: job.title, from }, ujId, "passed_filter");
  }
}

async function findDuplicate(db: SupabaseClient, userId: string, job: any): Promise<string | null> {
  if (!job.company || !job.title_norm) return null;
  const rows = must(await db.from("user_jobs").select("job_id, status, jobs!inner(company, title_norm, location, requisition_id)")
    .eq("user_id", userId).neq("job_id", job.id).neq("status", "duplicate")
    .ilike("jobs.company", job.company).eq("jobs.title_norm", job.title_norm)) as any[];
  const hit = rows.find((r) => (r.jobs.location ?? "") === (job.location ?? "")
    && !(r.jobs.requisition_id && job.requisition_id && r.jobs.requisition_id !== job.requisition_id));
  return hit?.job_id ?? null;
}

async function setStatus(db: SupabaseClient, id: string, patch: object) {
  must(await db.from("user_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id));
}

async function evaluateStage(db: SupabaseClient, run: any, profile: any, cv: any, log: RunLog, deps: Deps, maxEvals: number, budget: number) {
  const pending = must(await db.from("user_jobs").select("id, status, jobs(*)").eq("user_id", run.user_id)
    .in("status", ["eval_pending", "eval_failed"]).order("updated_at")) as any[];
  if (pending.length > maxEvals) await log.emit("evaluate", "quota_trimmed", { pending: pending.length, max_evals_per_run: maxEvals });

  const candidate: Candidate = {
    target_titles: profile.target_titles, cv_text: cv.text, parsed: cv.parsed, cities: profile.cities,
    accepts_remote: profile.accepts_remote, accepts_hybrid: profile.accepts_hybrid, exp_min: profile.exp_min, exp_max: profile.exp_max,
    pay_currency: profile.pay_currency, pay_min_annual: profile.pay_min_annual, authorized_in: profile.authorized_in,
    needs_sponsorship: profile.needs_sponsorship,
  };
  const usage: Usage = (u) => recordLlm(db, log, u);

  for (const uj of pending.slice(0, maxEvals)) {
    if ((await monthSpend(db, "llm")) >= budget) {
      await log.emit("evaluate", "quota_trimmed", { reason: "monthly LLM budget reached", budget_usd: budget });
      break;
    }
    const job = uj.jobs;
    const result = await withOneRetry((prev) => deps.score(candidate, job, usage, prev));
    if (!result.ok) {
      log.failures++;
      await setStatus(db, uj.id, { status: "eval_failed", reason_code: "eval_failed", reason_text: result.error });
      await log.emit("evaluate", "failed", { title: job.title, error: result.error }, uj.id, "failed");
      continue;
    }
    const total = computeTotal(result.value);
    const to = route(total);
    await setStatus(db, uj.id, {
      status: to, total, eval: { ...result.value, total }, stale: false, profile_version: profile.profile_version, last_run_id: log.runId,
      reason_code: to === "discarded" ? "score_below_3_5" : null, reason_text: result.value.rationale,
    });
    await log.emit("evaluate", "scored", { title: job.title, total, criteria: result.value.criteria, rationale: result.value.rationale }, uj.id, "scored");
    await log.emit("route", to, { title: job.title, total }, uj.id, to);
    if (to === "apply") await prepare(db, log, uj.id, job);
  }
}

/** Stage 8: match known form questions to the answer bank. Never invents answers. */
async function prepare(db: SupabaseClient, log: RunLog, ujId: string, job: any) {
  let questions: { label: string; required: boolean }[] = job.ats_questions ?? [];
  const src = job.source_id ? (must(await db.from("sources").select("provider, provider_ref").eq("id", job.source_id).maybeSingle()) as any) : null;
  if (!job.ats_questions && src?.provider === "greenhouse" && job.external_id) {
    try {
      const d = await httpJson<{ questions?: { label: string; required: boolean }[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${src.provider_ref}/jobs/${job.external_id}?questions=true`);
      questions = (d.questions ?? []).map((q) => ({ label: q.label, required: !!q.required }));
      await db.from("jobs").update({ ats_questions: questions }).eq("id", job.id);
    } catch {} // questions unknown → the extension handles them when the form is opened
  }
  const bank = new Set(((must(await db.from("answer_bank").select("question_key").eq("user_id", log.userId)) as any[])).map((a) => a.question_key));
  const missing = missingAnswers(questions, bank);
  if (missing.length) {
    await setStatus(db, ujId, { status: "needs_input", reason_text: "Answers needed: " + missing.map((m) => m.label).join("; ") });
    await log.emit("prepare", "needs_input", { title: job.title, questions: missing.map((m) => m.label), apply_url: job.apply_url }, ujId, "needs_input");
  } else {
    await setStatus(db, ujId, { status: "ready_to_submit" });
    await log.emit("prepare", "ready", { title: job.title, apply_url: job.apply_url }, ujId, "ready_to_submit");
  }
}

async function recordLlm(db: SupabaseClient, log: RunLog, u: { model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
  const inCost = costUsd(u.model, { input: u.input, output: 0, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
  const outCost = costUsd(u.model, { input: 0, output: u.output });
  await db.from("usage_ledger").insert([
    { user_id: log.userId, run_id: log.runId, kind: "llm_input_tokens", model: u.model, units: u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), cost_usd: inCost },
    { user_id: log.userId, run_id: log.runId, kind: "llm_output_tokens", model: u.model, units: u.output, cost_usd: outCost },
  ]);
}

async function recordCredits(db: SupabaseClient, log: RunLog, credits: number) {
  await db.from("usage_ledger").insert({ user_id: log.userId, run_id: log.runId, kind: "firecrawl_credits", units: Math.ceil(credits), cost_usd: 0 });
}
