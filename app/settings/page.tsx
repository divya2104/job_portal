import { loadProfileData } from "../profile-data";
import { AnswersForm, CompaniesForm, CvConfirmForm, CvUploadForm, LocationForm, PayForm, RolesForm } from "../profile-forms";
import { GeneratePassword, SetPasswordForm } from "../forms-client";
import { deleteMyAccount, newOwnPassword } from "../auth-actions";
import { Nav } from "../nav";

export const maxDuration = 60; // server actions here call the LLM (CV parsing)

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; review?: string }> }) {
  const sp = await searchParams;
  const d = await loadProfileData();
  return (
    <>
      <Nav email={d.user.email!} isAdmin={d.profile.is_admin} />
      <main>
        <h1>Settings</h1>
        <p className="muted">Changing your roles, CV, location or pay marks existing scores as stale; you can re-score open jobs from the dashboard.</p>
        {sp.error && <p className="error" role="alert">{sp.error}</p>}
        {sp.saved && <p className="ok" role="status">Saved.</p>}

        <section className="card" id="s1"><h2>Target roles</h2><RolesForm mode="settings" profile={d.profile} review={!!sp.review} /></section>
        <section className="card" id="s2"><h2>CV</h2><CvUploadForm mode="settings" current={d.activeCv?.file_name} /></section>
        {d.pendingCv && (
          <section className="card" id="s3"><h2>Confirm your new CV</h2><CvConfirmForm mode="settings" cv={d.pendingCv} profile={d.profile} /></section>
        )}
        {!d.pendingCv && d.activeCv && (
          <section className="card" id="s3"><h2>CV profile</h2><CvConfirmForm mode="settings" cv={d.activeCv} profile={d.profile} /></section>
        )}
        <section className="card" id="s4"><h2>Location</h2><LocationForm mode="settings" profile={d.profile} /></section>
        <section className="card" id="s5"><h2>Pay & work authorisation</h2><PayForm mode="settings" profile={d.profile} /></section>
        <section className="card" id="s6"><h2>Application answers</h2><AnswersForm mode="settings" profile={d.profile} cv={d.activeCv?.parsed ?? null} answers={d.answers} /></section>
        <section className="card" id="s7"><h2>Saved companies</h2><CompaniesForm mode="settings" sources={d.sources} saved={d.savedIds} /></section>

        <section className="card" id="password">
          <h2>Password</h2>
          <GeneratePassword action={newOwnPassword} label="Generate a new password" />
          <SetPasswordForm />
        </section>

        <section className="card" id="delete">
          <h2>Delete my account and data</h2>
          <p>Permanently deletes your CV files, profile, answers, saved companies, runs and job results. This can't be undone.</p>
          <form action={deleteMyAccount}>
            <label htmlFor="confirm">Type DELETE to confirm</label>
            <input id="confirm" name="confirm" type="text" autoComplete="off" required />
            <div className="actions"><button className="danger">Delete everything</button></div>
          </form>
        </section>
      </main>
    </>
  );
}
