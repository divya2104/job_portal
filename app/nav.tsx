import { logout } from "./auth-actions";

export function Nav({ email, isAdmin }: { email: string; isAdmin?: boolean }) {
  return (
    <nav className="top" aria-label="Main">
      <a href="/dashboard">Dashboard</a>
      <a href="/settings">Settings</a>
      {isAdmin && <a href="/admin">Admin</a>}
      <span className="spacer" />
      <span className="muted">{email}</span>
      <form action={logout}><button className="secondary">Log out</button></form>
    </nav>
  );
}
