import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase";
import { startOfMonth } from "@/lib/quota";
import { adminResetPassword } from "../auth-actions";
import { GeneratePassword } from "../forms-client";
import { Nav } from "../nav";

// Admin only (profiles.is_admin). Reads go through RLS policies that allow is_admin(); CV content is never readable here.

async function requireAdmin() {
  const ctx = await requireUser();
  if (!ctx.profile.is_admin) redirect("/dashboard");
  return ctx;
}

const optInt = (v: FormDataEntryValue | null) => (String(v ?? "").trim() === "" ? null : Math.max(0, Math.round(Number(v))));

async function addEmail(form: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email) await supabase.from("allowed_emails").upsert({ email });
  revalidatePath("/admin");
}

async function removeEmail(form: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  await supabase.from("allowed_emails").delete().eq("email", String(form.get("email")));
  revalidatePath("/admin");
}

async function saveSettings(form: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const n = (k: string) => Number(form.get(k));
  await supabase.from("app_settings").update({
    max_users: n("max_users"), max_runs_per_day: n("max_runs_per_day"), max_sources_per_run: n("max_sources_per_run"),
    max_evals_per_run: n("max_evals_per_run"), llm_monthly_budget_usd: n("llm_monthly_budget_usd"),
    firecrawl_monthly_credit_budget: n("firecrawl_monthly_credit_budget"), throttle_ms_per_domain: n("throttle_ms_per_domain"),
    firecrawl_max_pages: n("firecrawl_max_pages"),
  }).eq("id", true);
  revalidatePath("/admin");
}

async function saveUserLimits(userId: string, form: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  await supabase.from("user_limits").update({
    max_runs_per_day: optInt(form.get("max_runs_per_day")), max_sources_per_run: optInt(form.get("max_sources_per_run")),
    max_evals_per_run: optInt(form.get("max_evals_per_run")),
  }).eq("user_id", userId);
  revalidatePath("/admin");
}

export default async function Admin() {
  const { supabase, user } = await requireAdmin();
  const [users, invites, settings, limits, runs, ledger] = await Promise.all([
    supabase.from("profiles").select("user_id, email, onboarded_at, created_at, is_admin").order("created_at"),
    supabase.from("allowed_emails").select("email, added_at").order("added_at"),
    supabase.from("app_settings").select("*").single(),
    supabase.from("user_limits").select("*"),
    supabase.from("runs").select("user_id, status, created_at"),
    supabase.from("usage_ledger").select("user_id, kind, units, cost_usd").gte("created_at", startOfMonth()),
  ]);
  const s = settings.data!;
  const lim = new Map((limits.data ?? []).map((l) => [l.user_id, l]));
  const since30 = Date.now() - 30 * 86_400_000;
  const stats = (id: string) => {
    const r = (runs.data ?? []).filter((x) => x.user_id === id);
    const l = (ledger.data ?? []).filter((x) => x.user_id === id);
    return {
      runs: r.length, runs30: r.filter((x) => Date.parse(x.created_at) > since30).length,
      failed: r.filter((x) => x.status === "failed").length,
      last: r.map((x) => x.created_at).sort().at(-1),
      llm: l.filter((x) => x.kind !== "firecrawl_credits").reduce((a, x) => a + Number(x.cost_usd), 0),
      credits: l.filter((x) => x.kind === "firecrawl_credits").reduce((a, x) => a + Number(x.units), 0),
    };
  };
  const totalLlm = (ledger.data ?? []).filter((x) => x.kind !== "firecrawl_credits").reduce((a, x) => a + Number(x.cost_usd), 0);
  const totalCredits = (ledger.data ?? []).filter((x) => x.kind === "firecrawl_credits").reduce((a, x) => a + Number(x.units), 0);

  return (
    <>
      <Nav email={user.email!} isAdmin />
      <main className="wide">
        <h1>Admin</h1>
        <section className="quota" aria-label="This month">
          <div>AI spend this month: <strong>${totalLlm.toFixed(2)}</strong> of ${Number(s.llm_monthly_budget_usd).toFixed(2)} budget</div>
          <div>Firecrawl: <strong>{totalCredits}</strong> of {s.firecrawl_monthly_credit_budget} credits</div>
          <div>Users: <strong>{users.data?.length ?? 0}</strong> of {s.max_users}</div>
        </section>

        <section className="card">
          <h2>Users</h2>
          <p className="muted">Blank cap = app default ({s.max_runs_per_day} runs/day, {s.max_sources_per_run} companies/run, {s.max_evals_per_run} scored jobs/run).</p>
          <table className="list">
            <thead><tr><th>User</th><th>Runs (30 d / all)</th><th>AI $ · credits (month)</th><th>Caps: runs/day · companies · scored</th><th>Password</th></tr></thead>
            <tbody>
              {(users.data ?? []).map((u) => {
                const st = stats(u.user_id);
                const l: any = lim.get(u.user_id) ?? {};
                return (
                  <tr key={u.user_id}>
                    <td>{u.email}{u.is_admin && " (admin)"}<div className="muted small">{u.onboarded_at ? "onboarded" : "not onboarded"}{st.last && ` · last run ${new Date(st.last).toLocaleDateString("en-IN")}`}</div></td>
                    <td>{st.runs30} / {st.runs}{st.failed > 0 && <div className="error small">{st.failed} failed</div>}</td>
                    <td>${st.llm.toFixed(2)} · {st.credits}</td>
                    <td>
                      <form action={saveUserLimits.bind(null, u.user_id)} className="caps">
                        <input name="max_runs_per_day" type="number" min="0" defaultValue={l.max_runs_per_day ?? ""} placeholder={String(s.max_runs_per_day)} aria-label={`${u.email} runs per day`} />
                        <input name="max_sources_per_run" type="number" min="0" defaultValue={l.max_sources_per_run ?? ""} placeholder={String(s.max_sources_per_run)} aria-label={`${u.email} companies per run`} />
                        <input name="max_evals_per_run" type="number" min="0" defaultValue={l.max_evals_per_run ?? ""} placeholder={String(s.max_evals_per_run)} aria-label={`${u.email} scored jobs per run`} />
                        <button className="secondary">Save</button>
                      </form>
                    </td>
                    <td>{u.user_id !== user.id && <GeneratePassword action={adminResetPassword.bind(null, u.user_id)} label="Reset" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>App settings</h2>
          <form action={saveSettings}>
            <div className="row">
              {([
                ["max_users", "Max users"], ["max_runs_per_day", "Default runs per day"], ["max_sources_per_run", "Default companies per run"],
                ["max_evals_per_run", "Default scored jobs per run"], ["llm_monthly_budget_usd", "AI budget per month (USD, all users)"],
                ["firecrawl_monthly_credit_budget", "Firecrawl credits per month (all users)"], ["throttle_ms_per_domain", "Delay between requests to one site (ms)"],
                ["firecrawl_max_pages", "Max pages per scraped site"],
              ] as const).map(([k, label]) => (
                <div key={k}>
                  <label htmlFor={k}>{label}</label>
                  <input id={k} name={k} type="number" min="0" step={k === "llm_monthly_budget_usd" ? "0.01" : "1"} defaultValue={s[k]} required />
                </div>
              ))}
            </div>
            <div className="actions"><button>Save settings</button></div>
          </form>
        </section>

        <section className="card">
          <h2>Invite list</h2>
          <p className="muted">Only these emails can create an account.</p>
          <table className="list">
            <tbody>
              {(invites.data ?? []).map((i) => (
                <tr key={i.email}>
                  <td>{i.email}</td>
                  <td className="row-actions"><form action={removeEmail}><input type="hidden" name="email" value={i.email} /><button className="secondary">Remove</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
          <form action={addEmail}>
            <label htmlFor="email">Add email</label>
            <div className="row-input">
              <input id="email" name="email" type="email" required />
              <button>Invite</button>
            </div>
          </form>
        </section>
      </main>
    </>
  );
}
