import { SignupForm } from "../forms-client";

export default function Signup() {
  return (
    <main>
      <h1>Create account</h1>
      <section className="card">
        <SignupForm />
      </section>
      <p className="muted">Already have one? <a href="/login">Log in</a></p>
    </main>
  );
}
