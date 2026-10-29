"use server";

import { redirect } from "next/navigation";
import { adminClient, requireUser, userClient } from "@/lib/supabase";
import { createAccount, deleteAccount, resetPassword } from "@/lib/account";
import { generatePassword } from "@/lib/password";

export type FormState = { error?: string; password?: string; email?: string } | undefined;

export async function login(_: FormState, form: FormData): Promise<FormState> {
  const supabase = await userClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email")).trim().toLowerCase(),
    password: String(form.get("password")),
  });
  if (error) return { error: "Wrong email or password." };
  redirect("/dashboard"); // proxy.ts sends not-yet-onboarded users to /onboarding
}

export async function signup(_: FormState, form: FormData): Promise<FormState> {
  try {
    const { email, password } = await createAccount(adminClient(), String(form.get("email") ?? ""));
    const supabase = await userClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { email, password }; // shown once by the client form, never stored
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function logout() {
  const supabase = await userClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function newOwnPassword(): Promise<FormState> {
  const { supabase } = await requireUser();
  const password = generatePassword();
  const { error } = await supabase.auth.updateUser({ password });
  return error ? { error: error.message } : { password };
}

export async function setOwnPassword(_: FormState, form: FormData): Promise<FormState> {
  const { supabase } = await requireUser();
  const password = String(form.get("password") ?? "");
  if (password.length < 12) return { error: "Use at least 12 characters." };
  const { error } = await supabase.auth.updateUser({ password });
  return error ? { error: error.message } : { password: "Password updated." };
}

export async function adminResetPassword(userId: string): Promise<FormState> {
  const { profile } = await requireUser();
  if (!profile.is_admin) return { error: "Admins only." };
  try {
    return { password: await resetPassword(adminClient(), userId) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function deleteMyAccount(form: FormData) {
  const { supabase, user } = await requireUser();
  if (String(form.get("confirm")) !== "DELETE") redirect("/settings?error=" + encodeURIComponent("Type DELETE to confirm."));
  await deleteAccount(adminClient(), user.id);
  await supabase.auth.signOut();
  redirect("/login?deleted=1");
}
