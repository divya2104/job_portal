"use client";

import { useActionState } from "react";
import { login, setOwnPassword, signup, type FormState } from "./auth-actions";

function ErrorMsg({ state }: { state: FormState }) {
  return state?.error ? <p className="error" role="alert">{state.error}</p> : null;
}

function Secret({ password }: { password: string }) {
  return (
    <>
      <p className="secret" aria-label="Your password">{password}</p>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => navigator.clipboard.writeText(password)}>Copy password</button>
      </div>
      <p className="hint">Save it in your password manager now. It won't be shown again.</p>
    </>
  );
}

export function LoginForm() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action}>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="username" required />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      <ErrorMsg state={state} />
      <div className="actions"><button disabled={pending}>Log in</button></div>
    </form>
  );
}

export function SignupForm() {
  const [state, action, pending] = useActionState(signup, undefined);
  if (state?.password)
    return (
      <>
        <p className="ok">Account created for {state.email}. This is your password:</p>
        {/* hidden username field lets browsers offer to save the generated password */}
        <form onSubmit={(e) => e.preventDefault()} aria-hidden="true" style={{ display: "none" }}>
          <input type="email" autoComplete="username" defaultValue={state.email} readOnly />
          <input type="password" autoComplete="new-password" defaultValue={state.password} readOnly />
        </form>
        <Secret password={state.password} />
        <div className="actions"><a href="/onboarding"><button type="button">I've saved it, continue</button></a></div>
      </>
    );
  return (
    <form action={action}>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="email" required />
      <p className="hint">We'll generate a strong password for you. No email is sent.</p>
      <ErrorMsg state={state} />
      <div className="actions"><button disabled={pending}>Create account</button></div>
    </form>
  );
}

/** Runs a server action that returns a one-time password and shows it once. */
export function GeneratePassword({ action, label }: { action: () => Promise<FormState>; label: string }) {
  const [state, run, pending] = useActionState(async () => action(), undefined);
  if (state?.password) return <Secret password={state.password} />;
  return (
    <form action={run}>
      <ErrorMsg state={state} />
      <button className="secondary" disabled={pending}>{label}</button>
    </form>
  );
}

export function SetPasswordForm() {
  const [state, action, pending] = useActionState(setOwnPassword, undefined);
  return (
    <form action={action}>
      <label htmlFor="new-password">Or set your own (min 12 characters)</label>
      <input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      <ErrorMsg state={state} />
      {state?.password && <p className="ok">{state.password}</p>}
      <div className="actions"><button className="secondary" disabled={pending}>Save password</button></div>
    </form>
  );
}
