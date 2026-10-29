"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { CRITERIA, reasonLabel } from "@/lib/labels";

type Run = { id: string; status: string; trigger: string; adhoc_url: string | null; counts: Record<string, number>; created_at: string; error: string | null };
type Ev = { id: number; run_id: string; user_job_id: string | null; stage: string; kind: string; payload: any; created_at: string };

const supabase = () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const ACTIVE = ["queued", "running"];

/**
 * Live pipeline view + job feed for the signed-in user's latest run. Supabase Realtime applies the same RLS
 * policies as queries, and we also filter on user_id, so only this user's rows ever arrive.
 */
export function Live({ userId, initialRun, initialEvents }: { userId: string; initialRun: Run | null; initialEvents: Ev[] }) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(initialRun);
  const [events, setEvents] = useState<Ev[]>(initialEvents);
  const [connected, setConnected] = useState(false);
  const runId = useRef(initialRun?.id);

  useEffect(() => {
    const db = supabase();
    const load = async () => {
      // Catch-up: rows written before the subscription went live (see tests/realtime.test.ts).
      const { data: r } = await db.from("runs").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!r) return;
      const { data: ev } = await db.from("events").select("*").eq("run_id", r.id).order("id").limit(500);
      runId.current = r.id;
      setRun(r);
      setEvents(ev ?? []);
    };
    const channel = db.channel(`live-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "runs", filter: `user_id=eq.${userId}` }, ({ eventType, new: r }) => {
        const next = r as Run;
        if (eventType === "INSERT") {
          runId.current = next.id;
          setRun(next);
          setEvents([]);
        } else if (next.id === runId.current) {
          setRun(next);
          if (!ACTIVE.includes(next.status)) router.refresh(); // update queues and tab counts
        }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `user_id=eq.${userId}` }, ({ new: e }) => {
        const ev = e as Ev;
        if (ev.run_id === runId.current) setEvents((prev) => (prev.some((p) => p.id === ev.id) ? prev : [...prev, ev]));
      })
      .on("system", {}, (m: any) => {
        if (/Subscribed to PostgreSQL/i.test(m.message ?? "")) {
          setConnected(true);
          load();
        }
      })
      .subscribe((status) => status !== "SUBSCRIBED" && setConnected(false));
    return () => {
      db.removeChannel(channel);
    };
  }, [userId, router]);

  const cards = useMemo(() => jobCards(events), [events]);
  const sources = events.filter((e) => e.stage === "discover" && e.kind !== "job");
  if (!run) return null;
  const c = run.counts ?? {};
  const active = ACTIVE.includes(run.status);

  return (
    <section className="card live" aria-labelledby="live-h">
      <header className="live-head">
        <h2 id="live-h">{active ? "Run in progress" : "Latest run"}</h2>
        <span className={`status ${run.status}`}>{run.status.replaceAll("_", " ")}</span>
        <span className="muted small">
          {run.trigger === "adhoc" ? run.adhoc_url : run.trigger === "rescore" ? "Re-score" : "Saved companies"} · {new Date(run.created_at).toLocaleTimeString("en-IN", { timeStyle: "short" })}
        </span>
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "Live" : "Connecting…"} aria-label={connected ? "Live updates on" : "Connecting to live updates"} />
      </header>

      <ol className="pipeline" aria-live="polite">
        <Stage label="Discovered" n={c.discovered} />
        <Stage label="Extracted" n={c.extracted} sub={c.duplicate ? `${c.duplicate} duplicate` : undefined} />
        <Stage label="Filtered" n={(c.filtered ?? 0) + (c.expired ?? 0) + (c.uncertain ?? 0)} sub={`${c.passed_filter ?? 0} passed`} />
        <Stage label="Scored" n={c.scored} sub={c.failed ? `${c.failed} failed` : undefined} />
        <Stage label="Routed" n={(c.apply ?? 0) + (c.review ?? 0) + (c.discarded ?? 0)} sub={`${c.apply ?? 0} apply · ${c.review ?? 0} review · ${c.discarded ?? 0} out`} />
      </ol>
      {run.error && <p className="error small">{run.error}</p>}
      {sources.length > 0 && (
        <p className="muted small">
          {sources.map((s) => s.kind === "source_ok" ? `${s.payload.source}: ${s.payload.matched} of ${s.payload.found} matched` : `${s.payload.source}: ${s.payload.status ?? s.kind} ${s.payload.error ?? s.payload.reason ?? ""}`).join(" · ")}
        </p>
      )}

      {cards.length > 0 && (
        <ul className="feed">
          {cards.slice(0, 60).map((j) => (
            <li key={j.id} className={`feed-item ${j.tone}`}>
              <div className="feed-top">
                <strong>{j.title}</strong>
                {j.total !== undefined && <span className="feed-score">{Number(j.total).toFixed(2)}</span>}
              </div>
              <div className="muted small">{[j.company, j.location].filter(Boolean).join(" · ")}</div>
              <ol className="stages" aria-label="Progress">
                {["discover", "extract", "liveness", "filter", "evaluate", "route"].map((s) => (
                  <li key={s} className={j.stages.has(s) ? "done" : ""}>{STAGE_LABEL[s]}</li>
                ))}
              </ol>
              <p className="feed-msg">{j.message}</p>
              {j.evidence && <blockquote className="small">{j.evidence}</blockquote>}
              {j.criteria && (
                <details><summary className="small">Score breakdown</summary>
                  <ul className="small">{CRITERIA.map(([k, l]) => <li key={k}>{l}: {j.criteria[k]?.score ?? "n/a"} — {j.criteria[k]?.why}</li>)}</ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {active && cards.length === 0 && <p className="muted small">Waiting for the first jobs…</p>}
    </section>
  );
}

function Stage({ label, n, sub }: { label: string; n?: number; sub?: string }) {
  return (
    <li>
      <span className="n">{n ?? 0}</span>
      <span className="l">{label}</span>
      {sub && <span className="s">{sub}</span>}
    </li>
  );
}

const STAGE_LABEL: Record<string, string> = { discover: "Found", extract: "Read", liveness: "Open?", filter: "Filter", evaluate: "Score", route: "Route" };
const ROUTE_LABEL: Record<string, string> = { apply: "→ Apply queue", review: "→ Review queue", discarded: "→ Discarded (below 3.5)" };

/** Fold a run's events into one card per job, newest activity first. */
function jobCards(events: Ev[]) {
  const map = new Map<string, any>();
  for (const e of events) {
    if (!e.user_job_id) continue;
    const j = map.get(e.user_job_id) ?? { id: e.user_job_id, stages: new Set<string>(), tone: "", message: "" };
    const p = e.payload ?? {};
    j.title ??= p.title;
    j.company ??= p.company;
    j.location ??= p.location;
    j.stages.add(e.stage);
    j.last = e.id;
    if (e.stage === "discover") j.message = "Found";
    if (e.stage === "extract") j.message = "Reading the posting…";
    if (e.stage === "dedupe") Object.assign(j, { message: reasonLabel("duplicate_of:"), tone: "out" });
    if (e.stage === "liveness" && e.kind !== "live") Object.assign(j, { message: reasonLabel(e.kind === "expired" ? "expired" : "liveness_uncertain"), tone: "out" });
    if (e.stage === "liveness" && e.kind === "live") j.message = "Posting is open";
    if (e.stage === "filter" && e.kind === "discarded") Object.assign(j, { message: `Filtered: ${reasonLabel(p.reason_code)}`, evidence: p.evidence, tone: "out" });
    if (e.stage === "filter" && e.kind === "passed") j.message = "Passed the filters, waiting to be scored";
    if (e.stage === "evaluate" && e.kind === "scored") Object.assign(j, { total: p.total, criteria: p.criteria, message: p.rationale });
    if (e.stage === "evaluate" && e.kind === "failed") Object.assign(j, { message: reasonLabel("eval_failed"), tone: "out" });
    if (e.stage === "route") Object.assign(j, { tone: e.kind, message: `${ROUTE_LABEL[e.kind] ?? e.kind}. ${j.message ?? ""}` });
    if (e.stage === "prepare") j.message = e.kind === "ready" ? "Ready to submit" : `Needs your answers: ${(p.questions ?? []).join("; ")}`;
    map.set(e.user_job_id, j);
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}
