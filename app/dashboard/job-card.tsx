import { answerQuestions } from "./actions";
import { CRITERIA } from "@/lib/labels";


export function Score({ total }: { total: number | null }) {
  if (total === null) return null;
  const tone = total >= 4 ? "good" : total >= 3.5 ? "mid" : "low";
  return <span className={`score ${tone}`} aria-label={`Score ${total} out of 5`}>{Number(total).toFixed(2)}</span>;
}

export function JobCard({ uj }: { uj: any }) {
  const j = uj.jobs;
  const e = uj.eval;
  const questions = (j.ats_questions ?? []) as { label: string; required: boolean }[];
  const missingLabels = uj.status === "needs_input" ? (uj.reason_text ?? "").replace(/^Answers needed: /, "").split("; ").filter(Boolean) : [];
  const missing = questions.filter((q) => missingLabels.includes(q.label));
  return (
    <article className="card job">
      <header>
        <div>
          <h3>{j.title}</h3>
          <p className="muted">{[j.company, j.location, j.work_mode].filter(Boolean).join(" · ")}</p>
        </div>
        <Score total={uj.total} />
      </header>
      {uj.stale && <p className="badge warn">Scored against an older profile</p>}
      {e?.legitimacy?.tier === "suspicious" && <p className="badge bad">Posting looks suspicious: {e.legitimacy.signals.join("; ")}</p>}
      {e && <p>{e.rationale}</p>}
      {e && (
        <details>
          <summary>Score breakdown</summary>
          <table className="crit">
            <tbody>
              {CRITERIA.map(([k, label]) => (
                <tr key={k}>
                  <th>{label}</th>
                  <td>{e.criteria[k].score ?? "n/a"}</td>
                  <td className="muted">{e.criteria[k].why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {e.matched_skills.length > 0 && <p><strong>Matched:</strong> {e.matched_skills.join(", ")}</p>}
          {e.missing_skills.length > 0 && <p><strong>Missing:</strong> {e.missing_skills.join(", ")}</p>}
          {e.injection_flags.length > 0 && <p className="badge bad">The posting contained instructions aimed at AI screeners (ignored).</p>}
        </details>
      )}
      {uj.status === "needs_input" && missing.length > 0 && (
        <form action={answerQuestions.bind(null, uj.id)} className="questions">
          <p className="badge warn">This form asks questions you haven't answered yet. Answers are saved for next time.</p>
          {missing.map((q) => (
            <div key={q.label}>
              <label htmlFor={`${uj.id}-${q.label}`}>{q.label}</label>
              <input id={`${uj.id}-${q.label}`} name={q.label} type="text" required />
            </div>
          ))}
          <div className="actions"><button>Save answers</button></div>
        </form>
      )}
      <div className="actions">
        {(uj.status === "ready_to_submit" || uj.status === "needs_input") && (
          <a className="button" href={`${j.apply_url}#jp=${uj.id}`} target="_blank" rel="noopener noreferrer">Open &amp; fill</a>
        )}
        <a href={j.source_url ?? j.apply_url} target="_blank" rel="noopener noreferrer">View posting</a>
      </div>
    </article>
  );
}
