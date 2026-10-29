import { confirmCv, saveAnswers, saveCompanies, saveLocation, savePay, saveRoles, uploadCv } from "./profile-actions";
import { SENIORITY, type ParsedCv } from "@/lib/cv";
import { COMMON_QUESTIONS } from "@/lib/questions";

// Server-rendered form sections shared by /onboarding and /settings.
type Mode = "onboarding" | "settings";
type Profile = Record<string, any>;

function Hidden({ mode, step }: { mode: Mode; step: number }) {
  return (
    <>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="step" value={step} />
    </>
  );
}
const submitLabel = (mode: Mode) => (mode === "onboarding" ? "Save and continue" : "Save");

export function RolesForm({ mode, profile, review }: { mode: Mode; profile: Profile; review: boolean }) {
  const t = profile.target_titles as string[];
  const kw = profile.title_keywords as { positive: string[]; negative: string[] };
  const showKeywords = review || kw.positive.length > 0;
  return (
    <form action={saveRoles}>
      <Hidden mode={mode} step={1} />
      <label htmlFor="title1">Target job titles (1–3)</label>
      <p className="hint">These decide which listings we look for, e.g. "Product Manager", "AI Product Manager".</p>
      {[0, 1, 2].map((i) => (
        <input key={i} id={`title${i + 1}`} name={`title${i + 1}`} type="text" defaultValue={t[i] ?? ""} required={i === 0}
          aria-label={`Target title ${i + 1}`} style={{ marginTop: 6 }} />
      ))}
      {showKeywords && (
        <>
          <label htmlFor="positive">Titles to match (synonyms included)</label>
          <textarea id="positive" name="positive" defaultValue={kw.positive.join(", ")} />
          <p className="hint">Comma-separated. A listing must contain at least one of these.</p>
          <label htmlFor="negative">Title words to exclude</label>
          <textarea id="negative" name="negative" defaultValue={kw.negative.join(", ")} />
          <p className="hint">Listings whose title contains any of these are skipped (e.g. Engineer, Director).</p>
        </>
      )}
      <div className="actions">
        <button name="intent" value="save">{showKeywords ? submitLabel(mode) : "Suggest matching titles"}</button>
        {showKeywords && <button name="intent" value="suggest" className="secondary">Re-suggest from titles</button>}
      </div>
    </form>
  );
}

export function CvUploadForm({ mode, current }: { mode: Mode; current?: string }) {
  return (
    <form action={uploadCv}>
      <Hidden mode={mode} step={2} />
      {current && <p className="muted">Current CV: {current}</p>}
      <label htmlFor="cv">{current ? "Upload a new CV" : "Your CV"} (PDF or DOCX, max 4 MB)</label>
      <input id="cv" name="cv" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required />
      <p className="hint">We read it to build your profile; you'll review everything before it's saved.</p>
      <div className="actions"><button>Upload and read CV</button></div>
    </form>
  );
}

export function CvConfirmForm({ mode, cv, profile }: { mode: Mode; cv: { id: string; file_name: string; parsed: ParsedCv }; profile: Profile }) {
  const p = cv.parsed;
  const y = Math.round(p.total_years);
  return (
    <form action={confirmCv}>
      <Hidden mode={mode} step={3} />
      <input type="hidden" name="cv_id" value={cv.id} />
      <p className="muted">Read from <strong>{cv.file_name}</strong>. Fix anything that's wrong, then confirm.</p>
      <label htmlFor="skills">Skills</label>
      <textarea id="skills" name="skills" defaultValue={p.skills.join(", ")} />
      <div className="row">
        <div>
          <label htmlFor="total_years">Total years of experience</label>
          <input id="total_years" name="total_years" type="number" step="0.5" min="0" max="60" defaultValue={p.total_years} required />
        </div>
        <div>
          <label htmlFor="seniority">Seniority</label>
          <select id="seniority" name="seniority" defaultValue={p.seniority}>
            {SENIORITY.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="domains">Domains / industries</label>
      <textarea id="domains" name="domains" defaultValue={p.domains.join(", ")} />
      <label htmlFor="education">Education</label>
      <textarea id="education" name="education"
        defaultValue={p.education.map((e) => [e.degree, e.institution, e.year].filter(Boolean).join(" | ")).join("\n")} />
      <p className="hint">One per line: Degree | Institution | Year</p>
      <label>Experience range you're targeting (years required by the job)</label>
      <div className="row">
        <input name="exp_min" type="number" min="0" aria-label="Minimum years" defaultValue={profile.exp_min ?? Math.max(0, y - 2)} required />
        <input name="exp_max" type="number" min="0" aria-label="Maximum years" defaultValue={profile.exp_max ?? y + 1} required />
      </div>
      <p className="hint">Jobs asking for more than the max, or capped below the min, are filtered out. Default: your years −2 to +1.</p>
      <div className="actions"><button>Confirm profile</button></div>
    </form>
  );
}

export function LocationForm({ mode, profile }: { mode: Mode; profile: Profile }) {
  return (
    <form action={saveLocation}>
      <Hidden mode={mode} step={4} />
      <label htmlFor="cities">Preferred cities</label>
      <input id="cities" name="cities" type="text" defaultValue={profile.cities.join(", ")} placeholder="Bengaluru, Mumbai" />
      <p className="hint">Comma-separated.</p>
      <label className="inline"><input type="checkbox" name="remote" defaultChecked={profile.accepts_remote} /> I accept fully remote roles</label>
      <label className="inline"><input type="checkbox" name="hybrid" defaultChecked={profile.accepts_hybrid} /> I accept hybrid roles in my cities</label>
      <div className="actions"><button>{submitLabel(mode)}</button></div>
    </form>
  );
}

export function PayForm({ mode, profile }: { mode: Mode; profile: Profile }) {
  return (
    <form action={savePay}>
      <Hidden mode={mode} step={5} />
      <div className="row">
        <div>
          <label htmlFor="pay_currency">Currency</label>
          <select id="pay_currency" name="pay_currency" defaultValue={profile.pay_currency ?? "INR"}>
            {["INR", "USD", "EUR", "GBP", "SGD", "AED"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pay_min_annual">Minimum annual pay (optional)</label>
          <input id="pay_min_annual" name="pay_min_annual" type="number" min="0" defaultValue={profile.pay_min_annual ?? ""} placeholder="2800000" />
        </div>
      </div>
      <p className="hint">Only used when a job states its salary. Jobs without a salary are never penalised.</p>
      <label htmlFor="authorized_in">Countries you're authorised to work in</label>
      <input id="authorized_in" name="authorized_in" type="text" defaultValue={profile.authorized_in.length ? profile.authorized_in.join(", ") : "India"} />
      <label className="inline"><input type="checkbox" name="needs_sponsorship" defaultChecked={profile.needs_sponsorship} /> I need visa sponsorship</label>
      <div className="actions"><button>{submitLabel(mode)}</button></div>
    </form>
  );
}

export function AnswersForm({ mode, profile, cv, answers }: { mode: Mode; profile: Profile; cv: ParsedCv | null; answers: Record<string, string> }) {
  return (
    <form action={saveAnswers}>
      <Hidden mode={mode} step={6} />
      <p className="muted">Used to fill application forms for you. Anything you type into a new form question later is saved here too.</p>
      {COMMON_QUESTIONS.map((q) => (
        <div key={q.key}>
          <label htmlFor={q.key}>{q.label}{q.required && " *"}</label>
          <input id={q.key} name={q.key} type="text" required={q.required}
            defaultValue={answers[q.key] ?? q.prefill?.(cv, profile as never) ?? ""} />
        </div>
      ))}
      <div className="actions"><button>{submitLabel(mode)}</button></div>
    </form>
  );
}

export function CompaniesForm({ mode, sources, saved }: { mode: Mode; sources: { id: string; name: string; provider: string }[]; saved: Set<string> }) {
  const preselect = mode === "onboarding" && saved.size === 0;
  return (
    <form action={saveCompanies}>
      <Hidden mode={mode} step={7} />
      <p className="muted">Their careers pages are checked every day at 10:00 IST. You can add your own companies from the dashboard later.</p>
      <div className="checks">
        {sources.map((s) => (
          <label key={s.id} className="inline">
            <input type="checkbox" name="source" value={s.id} defaultChecked={preselect || saved.has(s.id)} /> {s.name}
          </label>
        ))}
      </div>
      <div className="actions"><button>{mode === "onboarding" ? "Finish setup" : "Save"}</button></div>
    </form>
  );
}
