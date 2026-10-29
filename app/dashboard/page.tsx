import { requireUser } from "@/lib/supabase";
import { quotaFor } from "@/lib/quota";
import { Nav } from "../nav";
import { addCompany, removeCompany, rescore, runSaved, runUrl, setCompanyActive } from "./actions";
import { JobCard, Score } from "./job-card";
import { Live } from "./live";
import { reasonLabel } from "@/lib/labels";

const TABS = [
  ["apply", "Apply queue"], ["review", "Review queue"], ["discarded", "Discarded"], ["runs", "Run history"], ["companies", "Saved companies"],
] as const;
type Tab = (typeof TABS)[number][0];

const APPLY = ["ready_to_submit", "needs_input", "apply"];
const DISCARDED = ["filtered_out", "discarded", "duplicate", "expired", "unreachable", "eval_failed", "liveness_uncertain"];
const PROVIDER_LABEL: Record<string, string> = {
  greenhouse: "Greenhouse API", lever: "Lever API", ashby: "Ashby API", smartrecruiters: "SmartRecruiters API", workday: "Workday API", firecrawl: "Firecrawl (uses credits)",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "");

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ tab?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const tab: Tab = (TABS.find(([t]) => t === sp.tab)?.[0] ?? "apply") as Tab;
  const { supabase, user, profile } = await requireUser();

  const [all, quota, latest] = await Promise.all([
    supabase.from("user_jobs").select("status, stale"),
    quotaFor(supabase, user.id),
    supabase.from("runs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const latestEvents = latest.data
    ? (await supabase.from("events").select("*").eq("run_id", latest.data.id).order("id").limit(500)).data ?? []
    : [];
  const rows = all.data ?? [];
  const n = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;
  const stale = rows.filter((r) => r.stale).length;
  const pending = n(["eval_pending"]);
  const count: Record<Tab, number | null> = { apply: n(APPLY), review: n(["review"]), discarded: n(DISCARDED), runs: null, companies: null };

  return (
    <>
      <Nav email={user.email!} isAdmin={profile.is_admin} />
      <main className="wide">
        <h1>Dashboard</h1>
        <p className="muted">Searching for {profile.target_titles.join(", ")} · checked daily at 10:00 IST</p>

        <section className="quota" aria-label="Usage">
          <div><strong>{Math.max(0, quota.maxRunsPerDay - quota.runsToday)}</strong> of {quota.maxRunsPerDay} runs left today</div>
          <div>Up to <strong>{quota.maxSourcesPerRun}</strong> companies and <strong>{quota.maxEvalsPerRun}</strong> scored jobs per run</div>
          <div><strong>${quota.llmUsdThisMonth.toFixed(2)}</strong> AI spend · <strong>{quota.firecrawlCreditsThisMonth}</strong> Firecrawl credits this month</div>
        </section>

        {sp.error && <p className="error" role="alert">{sp.error}</p>}
        {sp.ok && <p className="ok" role="status">{sp.ok}</p>}

        <section className="card">
          <form action={runUrl} className="inline-form">
            <label htmlFor="url">Check a job board, careers page or single posting now</label>
            <div className="row-input">
              <input id="url" name="url" type="url" placeholder="https://jobs.lever.co/company/…" required />
              <button>Run</button>
            </div>
          </form>
          <div className="actions">
            <form action={runSaved}><button className="secondary">Run my saved companies now</button></form>
            {stale > 0 && <form action={rescore}><button className="secondary">Re-score {stale} job{stale > 1 ? "s" : ""} (profile changed)</button></form>}
          </div>
          {pending > 0 && <p className="muted">{pending} job{pending > 1 ? "s are" : " is"} waiting to be scored in the next run.</p>}
        </section>

        <Live userId={user.id} initialRun={latest.data} initialEvents={latestEvents} />

        <nav className="tabs" aria-label="Queues">
          {TABS.map(([t, label]) => (
            <a key={t} href={`/dashboard?tab=${t}`} aria-current={t === tab ? "page" : undefined}>
              {label}{count[t] !== null && <span className="count">{count[t]}</span>}
            </a>
          ))}
          <a href="/settings">Settings</a>
        </nav>

        {tab === "apply" && <ApplyTab />}
        {tab === "review" && <ReviewTab total={count.review!} />}
        {tab === "discarded" && <DiscardedTab />}
        {tab === "runs" && <RunsTab />}
        {tab === "companies" && <CompaniesTab />}
      </main>
    </>
  );

  async function ApplyTab() {
    const { data } = await supabase.from("user_jobs").select("*, jobs(*)").in("status", APPLY).order("total", { ascending: false });
    if (!data?.length) return <p className="empty">No jobs scored 4.0 or higher yet. Jobs land here after a run.</p>;
    return <>{data.map((uj) => <JobCard key={uj.id} uj={uj} />)}</>;
  }

  async function ReviewTab({ total }: { total: number }) {
    if (!total) return <p className="empty">No jobs scored between 3.5 and 4.0.</p>;
    const { data } = await supabase.from("user_jobs").select("*, jobs(*)").eq("status", "review").order("total", { ascending: false });
    return (
      <details className="reveal">
        <summary>Show {total} job{total > 1 ? "s" : ""} scored 3.5–3.99 (apply only with a specific reason)</summary>
        {data!.map((uj) => <JobCard key={uj.id} uj={uj} />)}
      </details>
    );
  }

  async function DiscardedTab() {
    const { data } = await supabase.from("user_jobs").select("id, status, reason_code, evidence, reason_text, total, updated_at, jobs(title, company, location, source_url)")
      .in("status", DISCARDED).order("updated_at", { ascending: false }).limit(200);
    if (!data?.length) return <p className="empty">Nothing discarded yet.</p>;
    return (
      <div className="card">
        <table className="list">
          <thead><tr><th>Job</th><th>Why</th><th>Evidence</th></tr></thead>
          <tbody>
            {data.map((uj: any) => (
              <tr key={uj.id}>
                <td><a href={uj.jobs.source_url} target="_blank" rel="noopener noreferrer">{uj.jobs.title}</a><div className="muted">{[uj.jobs.company, uj.jobs.location].filter(Boolean).join(" · ")}</div></td>
                <td>{reasonLabel(uj.reason_code ?? uj.status)} <Score total={uj.total} /></td>
                <td className="muted">{uj.evidence ?? uj.reason_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  async function RunsTab() {
    const { data } = await supabase.from("runs").select("*, run_sources(status, error, jobs_found, sources(name))").order("created_at", { ascending: false }).limit(30);
    if (!data?.length) return <p className="empty">No runs yet. Your saved companies are checked daily at 10:00 IST.</p>;
    return (
      <div className="card">
        <table className="list">
          <thead><tr><th>When</th><th>Type</th><th>Status</th><th>Results</th></tr></thead>
          <tbody>
            {data.map((r: any) => {
              const c = r.counts ?? {};
              return (
                <tr key={r.id}>
                  <td>{when(r.created_at)}</td>
                  <td>{r.trigger === "adhoc" ? <>Link<div className="muted small">{r.adhoc_url}</div></> : r.trigger === "rescore" ? "Re-score" : "Saved companies"}</td>
                  <td><span className={`status ${r.status}`}>{r.status.replaceAll("_", " ")}</span>{r.error && <div className="error small">{r.error}</div>}</td>
                  <td>
                    {c.discovered ?? 0} new · {c.filtered ?? 0} filtered · {c.scored ?? 0} scored → {c.apply ?? 0} apply / {c.review ?? 0} review / {c.discarded ?? 0} discarded
                    {c.seen ? ` · ${c.seen} already seen` : ""}
                    {r.run_sources?.length > 0 && (
                      <details><summary className="small">Sources</summary>
                        <ul className="small">{r.run_sources.map((s: any, i: number) => (
                          <li key={i}>{s.sources?.name}: {s.status}{s.jobs_found ? ` (${s.jobs_found} matching)` : ""}{s.error ? ` — ${s.error}` : ""}</li>
                        ))}</ul>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  async function CompaniesTab() {
    const [{ data: saved }, { data: starters }] = await Promise.all([
      supabase.from("saved_companies").select("id, active, sources(id, name, careers_url, provider)").order("id"),
      supabase.from("sources").select("id, name, careers_url, provider").eq("is_starter", true).order("name"),
    ]);
    const savedIds = new Set((saved ?? []).map((s: any) => s.sources.id));
    return (
      <>
        <div className="card">
          <h2>Your companies ({saved?.length ?? 0})</h2>
          <p className="muted">Active companies are checked every day at 10:00 IST (up to {quota.maxSourcesPerRun} per run).</p>
          <table className="list">
            <tbody>
              {(saved ?? []).map((s: any) => (
                <tr key={s.id}>
                  <td><a href={s.sources.careers_url} target="_blank" rel="noopener noreferrer">{s.sources.name}</a><div className="muted small">{PROVIDER_LABEL[s.sources.provider]}</div></td>
                  <td>{s.active ? "Active" : "Paused"}</td>
                  <td className="row-actions">
                    <form action={setCompanyActive.bind(null, s.id, !s.active)}><button className="secondary">{s.active ? "Pause" : "Resume"}</button></form>
                    <form action={removeCompany.bind(null, s.id)}><button className="secondary">Remove</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Add a company</h2>
          <form action={addCompany}>
            <label htmlFor="c-url">Careers page URL</label>
            <input id="c-url" name="url" type="url" required placeholder="https://jobs.ashbyhq.com/company" />
            <p className="hint">Greenhouse, Lever, Ashby, SmartRecruiters and Workday boards are read through their free APIs. Other sites use Firecrawl credits.</p>
            <label htmlFor="c-name">Name (optional)</label>
            <input id="c-name" name="name" type="text" />
            <div className="actions"><button>Add company</button></div>
          </form>
          {(starters ?? []).some((s) => !savedIds.has(s.id)) && (
            <>
              <h3>Popular companies</h3>
              <div className="chips">
                {(starters ?? []).filter((s) => !savedIds.has(s.id)).map((s) => (
                  <form key={s.id} action={addCompany}>
                    <input type="hidden" name="url" value={s.careers_url} />
                    <input type="hidden" name="name" value={s.name} />
                    <button className="secondary">+ {s.name}</button>
                  </form>
                ))}
              </div>
            </>
          )}
        </div>
      </>
    );
  }
}
