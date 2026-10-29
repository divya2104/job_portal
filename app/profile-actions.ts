"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase";
import { cvToText, MAX_CV_BYTES, parseCv, SENIORITY, suggestKeywords, type ParsedCv } from "@/lib/cv";
import { COMMON_QUESTIONS } from "@/lib/questions";

// Each form posts `mode` = onboarding | settings and its own `step`.
// Onboarding advances to the next step; settings returns to /settings.

const list = (v: FormDataEntryValue | null) =>
  [...new Set(String(v ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
const int = (v: FormDataEntryValue | null) => (String(v ?? "").trim() === "" ? null : Math.round(Number(v)));

function back(form: FormData, params: string): never {
  const step = String(form.get("step"));
  redirect(form.get("mode") === "settings" ? `/settings?${params}#s${step}` : `/onboarding?step=${step}&${params}`);
}
const fail = (form: FormData, msg: string): never => back(form, "error=" + encodeURIComponent(msg));

async function advance(form: FormData) {
  const step = Number(form.get("step"));
  if (form.get("mode") === "settings") back(form, "saved=1");
  const { supabase, user } = await requireUser();
  await supabase.from("profiles").update({ onboarding_step: step + 1 }).eq("user_id", user.id);
  redirect(`/onboarding?step=${step + 1}`);
}

async function bump() {
  const { supabase } = await requireUser();
  await supabase.rpc("bump_profile_version"); // marks existing scores stale (PLAN.md §3)
}

export async function saveRoles(form: FormData) {
  const { supabase, user, profile } = await requireUser();
  const titles = [form.get("title1"), form.get("title2"), form.get("title3")].map((t) => String(t ?? "").trim()).filter(Boolean);
  if (titles.length === 0) fail(form, "Enter at least one target job title.");

  const titlesChanged = titles.join("|") !== profile.target_titles.join("|");
  if (titlesChanged || form.get("intent") === "suggest" || profile.title_keywords.positive.length === 0) {
    let keywords;
    try {
      keywords = await suggestKeywords(titles);
    } catch {
      keywords = { positive: titles, negative: [] }; // still editable below
    }
    await supabase.from("profiles").update({ target_titles: titles, title_keywords: keywords }).eq("user_id", user.id);
    back(form, "review=1"); // show suggestions for review before moving on
  }

  const positive = list(form.get("positive"));
  if (positive.length === 0) fail(form, "Keep at least one title keyword.");
  await supabase.from("profiles")
    .update({ target_titles: titles, title_keywords: { positive, negative: list(form.get("negative")) } })
    .eq("user_id", user.id);
  await bump();
  await advance(form);
}

export async function uploadCv(form: FormData) {
  const { supabase, user } = await requireUser();
  const file = form.get("cv");
  if (!(file instanceof File) || file.size === 0) fail(form, "Choose a PDF or DOCX file.");
  const cv = file as File;
  if (cv.size > MAX_CV_BYTES) fail(form, "The file is larger than 4 MB.");
  const ext = cv.name.toLowerCase().split(".").pop();
  if (ext !== "pdf" && ext !== "docx") fail(form, "Upload a PDF or DOCX file.");

  const bytes = new Uint8Array(await cv.arrayBuffer());
  let text: string, parsed: ParsedCv;
  try {
    text = await cvToText(bytes, cv.name);
    parsed = await parseCv(text);
  } catch (e) {
    fail(form, (e as Error).message);
  }

  const path = `${user.id}/${randomUUID()}.${ext}`;
  const up = await supabase.storage.from("cvs").upload(path, bytes, { contentType: cv.type || undefined });
  if (up.error) fail(form, "Upload failed: " + up.error.message);

  // Not active until the user confirms the parsed profile.
  const { error } = await supabase.from("cvs").insert({
    user_id: user.id, storage_path: path, file_name: cv.name, parsed: parsed!, text: text!, is_active: false,
  });
  if (error) {
    await supabase.storage.from("cvs").remove([path]);
    fail(form, "Couldn't save the CV: " + error.message);
  }
  if (form.get("mode") === "settings") redirect("/settings?confirm=cv#s3");
  await advance(form);
}

export async function confirmCv(form: FormData) {
  const { supabase, user } = await requireUser();
  const id = String(form.get("cv_id"));
  const { data: cv } = await supabase.from("cvs").select("id, parsed").eq("id", id).eq("user_id", user.id).single();
  if (!cv) fail(form, "CV not found. Upload it again.");

  const years = Number(form.get("total_years"));
  const seniority = String(form.get("seniority"));
  if (!Number.isFinite(years) || years < 0 || years > 60) fail(form, "Enter total years of experience (0–60).");
  if (!(SENIORITY as readonly string[]).includes(seniority)) fail(form, "Pick a seniority level.");
  const expMin = int(form.get("exp_min")), expMax = int(form.get("exp_max"));
  if (expMin === null || expMax === null || expMin < 0 || expMax < expMin) fail(form, "Experience range: min must be ≥ 0 and ≤ max.");

  const parsed: ParsedCv = {
    ...(cv!.parsed as ParsedCv),
    skills: list(form.get("skills")),
    total_years: years,
    seniority: seniority as ParsedCv["seniority"],
    domains: list(form.get("domains")),
    education: String(form.get("education") ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [degree, institution = "", year = null] = l.split("|").map((s) => s.trim());
      return { degree, institution, year: year || null };
    }),
  };

  // One active CV per user: deactivate the old one first (partial unique index).
  await supabase.from("cvs").update({ is_active: false }).eq("user_id", user.id).neq("id", id);
  const { error } = await supabase.from("cvs").update({ parsed, confirmed_at: new Date().toISOString(), is_active: true }).eq("id", id);
  if (error) fail(form, error.message);
  await supabase.from("profiles").update({ exp_min: expMin, exp_max: expMax }).eq("user_id", user.id);
  await bump();
  await advance(form);
}

export async function saveLocation(form: FormData) {
  const { supabase, user } = await requireUser();
  const cities = list(form.get("cities"));
  const remote = form.get("remote") === "on";
  if (cities.length === 0 && !remote) fail(form, "Add at least one city, or accept remote roles.");
  await supabase.from("profiles")
    .update({ cities, accepts_remote: remote, accepts_hybrid: form.get("hybrid") === "on" })
    .eq("user_id", user.id);
  await bump();
  await advance(form);
}

export async function savePay(form: FormData) {
  const { supabase, user } = await requireUser();
  const min = String(form.get("pay_min_annual") ?? "").trim();
  if (min !== "" && !(Number(min) >= 0)) fail(form, "Minimum pay must be a positive number.");
  await supabase.from("profiles").update({
    pay_currency: String(form.get("pay_currency")),
    pay_min_annual: min === "" ? null : Number(min),
    authorized_in: list(form.get("authorized_in")),
    needs_sponsorship: form.get("needs_sponsorship") === "on",
  }).eq("user_id", user.id);
  await bump();
  await advance(form);
}

export async function saveAnswers(form: FormData) {
  const { supabase, user } = await requireUser();
  const source = form.get("mode") === "settings" ? "settings" : "onboarding";
  const rows = COMMON_QUESTIONS.map((q) => ({ q, answer: String(form.get(q.key) ?? "").trim() }));
  const missing = rows.filter((r) => r.q.required && !r.answer).map((r) => r.q.label);
  if (missing.length) fail(form, "Required: " + missing.join(", "));

  const filled = rows.filter((r) => r.answer);
  const { error } = await supabase.from("answer_bank").upsert(
    filled.map(({ q, answer }) => ({ user_id: user.id, question_key: q.key, question_label: q.label, answer, source, updated_at: new Date().toISOString() })),
    { onConflict: "user_id,question_key" },
  );
  if (error) fail(form, error.message);
  const cleared = rows.filter((r) => !r.answer).map((r) => r.q.key);
  if (cleared.length) await supabase.from("answer_bank").delete().eq("user_id", user.id).in("question_key", cleared);
  await advance(form);
}

export async function saveCompanies(form: FormData) {
  const { supabase, user } = await requireUser();
  const chosen = form.getAll("source").map(String);
  if (chosen.length === 0) fail(form, "Pick at least one company.");
  await supabase.from("saved_companies").delete().eq("user_id", user.id).not("source_id", "in", `(${chosen.join(",")})`);
  const { error } = await supabase.from("saved_companies").upsert(
    chosen.map((source_id) => ({ user_id: user.id, source_id, active: true })),
    { onConflict: "user_id,source_id" },
  );
  if (error) fail(form, error.message);

  if (form.get("mode") === "settings") back(form, "saved=1");
  await supabase.from("profiles").update({ onboarded_at: new Date().toISOString() }).eq("user_id", user.id);
  redirect("/dashboard");
}
