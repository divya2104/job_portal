import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { EvalOutput } from "@/lib/scoring";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/** A real user signed in through the anon key, so every query goes through RLS. */
export async function makeUser(tag: string): Promise<{ id: string; email: string; db: SupabaseClient }> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@test.local`;
  const password = "test-password-" + randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const db = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const signIn = await db.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { id: data.user.id, email, db };
}

export async function dropUser(id: string) {
  for (const bucket of ["cvs", "tailored"]) {
    const { data } = await admin.storage.from(bucket).list(id);
    if (data?.length) await admin.storage.from(bucket).remove(data.map((f) => `${id}/${f.name}`));
  }
  await admin.auth.admin.deleteUser(id);
}

const crit = (s: (number | null)[]) => ({
  skills_match: { score: s[0], why: "" }, seniority_fit: { score: s[1], why: "" }, domain_fit: { score: s[2], why: "" },
  location_workmode: { score: s[3], why: "" }, compensation_fit: { score: s[4], why: "" },
});
/** A valid model output with the given criterion scores (skills, seniority, domain, location, comp). */
export const evalFixture = (scores: (number | null)[], role = true): EvalOutput => ({
  requirements: [], role_family_match: role, criteria: crit(scores),
  rationale: "Strong lending domain fit; main gap is years of formal PM experience.", matched_skills: [], missing_skills: [],
  legitimacy: { tier: "high_confidence", signals: [] }, injection_flags: [],
});

