import type { SupabaseClient } from "@supabase/supabase-js";

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
export const startOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); };

/** Effective caps (per-user override or app default) plus today's/this month's usage for one user. */
export async function quotaFor(db: SupabaseClient, userId: string) {
  const [settings, limits, runsToday, ledger] = await Promise.all([
    db.from("app_settings").select("*").single(),
    db.from("user_limits").select("*").eq("user_id", userId).maybeSingle(),
    db.from("runs").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", startOfDay()),
    db.from("usage_ledger").select("kind, units, cost_usd").eq("user_id", userId).gte("created_at", startOfMonth()),
  ]);
  const s = settings.data!, l = limits.data ?? {};
  const cap = (k: "max_runs_per_day" | "max_sources_per_run" | "max_evals_per_run") => (l as any)[k] ?? s[k];
  const rows = ledger.data ?? [];
  return {
    maxRunsPerDay: cap("max_runs_per_day"),
    runsToday: runsToday.count ?? 0,
    maxSourcesPerRun: cap("max_sources_per_run"),
    maxEvalsPerRun: cap("max_evals_per_run"),
    llmUsdThisMonth: rows.filter((r) => r.kind !== "firecrawl_credits").reduce((a, r) => a + Number(r.cost_usd), 0),
    firecrawlCreditsThisMonth: rows.filter((r) => r.kind === "firecrawl_credits").reduce((a, r) => a + Number(r.units), 0),
  };
}
