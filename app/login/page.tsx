import { LoginForm } from "../forms-client";

export default async function Login({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const { deleted } = await searchParams;
  return (
    <main>
      <h1>Log in</h1>
      {deleted && <p className="ok">Your account and all its data were deleted.</p>}
      <section className="card">
        <LoginForm />
      </section>
      <p className="muted">
        New here? <a href="/signup">Create an account</a> (invite only). Forgot your password? Ask the admin to reset it.
      </p>
    </main>
  );
}
