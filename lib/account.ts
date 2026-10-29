import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePassword } from "./password.ts";

/**
 * Create an account for an allow-listed email with a generated password (PLAN.md §4.1).
 * `admin` must be a service-role client. Returns the password to show once.
 */
export async function createAccount(admin: SupabaseClient, rawEmail: string) {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");

  const { data: allowed } = await admin.from("allowed_emails").select("email").eq("email", email).maybeSingle();
  if (!allowed) throw new Error("This email isn't on the invite list. Ask the admin to add it.");

  const [{ count }, { data: settings }] = await Promise.all([
    admin.from("profiles").select("*", { count: "exact", head: true }),
    admin.from("app_settings").select("max_users").single(),
  ]);
  if ((count ?? 0) >= (settings?.max_users ?? 1)) throw new Error("The user limit has been reached. Ask the admin to raise it.");

  const password = generatePassword();
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message.includes("already") ? "An account with this email already exists. Log in instead." : error.message);
  return { email, password };
}

export async function resetPassword(admin: SupabaseClient, userId: string) {
  const password = generatePassword();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) throw new Error(error.message);
  return password;
}

/** Remove the user's files, then the auth user; every user-owned row cascades. */
export async function deleteAccount(admin: SupabaseClient, userId: string) {
  for (const bucket of ["cvs", "tailored"]) {
    const { data: files } = await admin.storage.from(bucket).list(userId);
    if (files?.length) {
      const { error } = await admin.storage.from(bucket).remove(files.map((f) => `${userId}/${f.name}`));
      if (error) throw new Error(`Couldn't delete files: ${error.message}`);
    }
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
}
