// Create two onboarded test users with fictional CVs (Phase 6 verification: the scheduled run must process both).
// Usage: node --env-file=.env.cloud scripts/seed-test-users.ts
// Parses the CVs with the real model (Haiku) and caps each user at 5 scored jobs per run to keep cost low.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { cvToText, parseCv, suggestKeywords } from "../lib/cv.ts";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data: sources } = await db.from("sources").select("id, name");
const src = Object.fromEntries((sources ?? []).map((s) => [s.name, s.id]));

const users = [
  { email: "sample-a@test.local", text: await cvToText(new Uint8Array(readFileSync("tests/fixtures/cv.pdf")), "cv.pdf"),
    titles: ["Product Manager", "AI Product Manager"], cities: ["Bengaluru", "Mumbai"], remote: true, companies: ["Razorpay", "Groww", "Atlan", "CRED", "Databricks"] },
  { email: "sample-b@test.local", text: readFileSync("tests/fixtures/cv-b.txt", "utf8"),
    titles: ["Data Analyst", "Business Analyst"], cities: ["Bengaluru"], remote: false, companies: ["Razorpay", "Groww", "Meesho", "Freshworks"] },
];

for (const u of users) {
  const { data: created, error } = await db.auth.admin.createUser({ email: u.email, password: randomBytes(18).toString("base64url"), email_confirm: true });
  if (error) throw new Error(`${u.email}: ${error.message}`);
  const id = created.user.id;
  const [parsed, kw] = await Promise.all([parseCv(u.text), suggestKeywords(u.titles)]);
  const y = Math.round(parsed.total_years);
  await db.from("cvs").insert({ user_id: id, storage_path: `${id}/cv.pdf`, file_name: "cv.pdf", parsed, text: u.text, is_active: true, confirmed_at: new Date().toISOString() });
  await db.from("profiles").update({
    onboarded_at: new Date().toISOString(), onboarding_step: 8, target_titles: u.titles, title_keywords: kw, cities: u.cities,
    accepts_remote: u.remote, accepts_hybrid: true, exp_min: Math.max(0, y - 2), exp_max: y + 1, pay_currency: "INR", authorized_in: ["India"],
  }).eq("user_id", id);
  await db.from("user_limits").update({ max_evals_per_run: 5 }).eq("user_id", id);
  await db.from("saved_companies").insert(u.companies.filter((n) => src[n]).map((n) => ({ user_id: id, source_id: src[n] })));
  console.log(`${u.email}: ${parsed.total_years} yrs, range ${Math.max(0, y - 2)}–${y + 1}, ${u.companies.length} companies`);
}
