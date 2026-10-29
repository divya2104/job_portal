import { redirect } from "next/navigation";
import { loadProfileData } from "../profile-data";
import { AnswersForm, CompaniesForm, CvConfirmForm, CvUploadForm, LocationForm, PayForm, RolesForm } from "../profile-forms";
import { logout } from "../auth-actions";

const TITLES = ["Target roles", "Upload your CV", "Confirm your profile", "Location", "Pay & work authorisation", "Application answers", "Companies to track"];

export const maxDuration = 60; // server actions here call the LLM (CV parsing)

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ step?: string; error?: string; review?: string }> }) {
  const sp = await searchParams;
  const d = await loadProfileData();
  const reached = d.profile.onboarding_step as number;
  const step = Math.min(Math.max(Number(sp.step) || reached, 1), reached, 7); // can go back, not skip ahead
  const cvForConfirm = d.pendingCv ?? d.activeCv;
  if (step === 3 && !cvForConfirm) redirect("/onboarding?step=2");

  return (
    <main>
      <h1>Set up your job search</h1>
      <p className="muted">Step {step} of 7 · {TITLES[step - 1]}. You only do this once.</p>
      <div className="steps" aria-hidden="true">{TITLES.map((_, i) => <span key={i} className={i < step ? "done" : ""} />)}</div>
      {sp.error && <p className="error" role="alert">{sp.error}</p>}
      <section className="card">
        <h2>{TITLES[step - 1]}</h2>
        {step === 1 && <RolesForm mode="onboarding" profile={d.profile} review={!!sp.review} />}
        {step === 2 && <CvUploadForm mode="onboarding" current={d.activeCv?.file_name} />}
        {step === 3 && <CvConfirmForm mode="onboarding" cv={cvForConfirm!} profile={d.profile} />}
        {step === 4 && <LocationForm mode="onboarding" profile={d.profile} />}
        {step === 5 && <PayForm mode="onboarding" profile={d.profile} />}
        {step === 6 && <AnswersForm mode="onboarding" profile={d.profile} cv={d.activeCv?.parsed ?? null} answers={d.answers} />}
        {step === 7 && <CompaniesForm mode="onboarding" sources={d.sources} saved={d.savedIds} />}
      </section>
      {step > 1 && <p><a href={`/onboarding?step=${step - 1}`}>← Back</a></p>}
      <form action={logout}><button className="secondary">Log out</button></form>
    </main>
  );
}
