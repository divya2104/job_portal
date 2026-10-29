"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminClient, requireUser } from "@/lib/supabase";
import { quotaFor } from "@/lib/quota";
import { dispatchRun } from "@/lib/dispatch";
import { missingAnswers, questionKey } from "@/lib/questions";
import { detectSource } from "@/worker/providers";

const back = (tab: string, msg: { ok?: string; error?: string }): never =>
  redirect(`/dashboard?tab=${tab}&` + new URLSearchParams(msg as Record<string, string>).toString());

/** Runs are written only by the server (users can't insert into `runs`); quota is checked first. */
async function queueRun(trigger: "adhoc" | "schedule" | "rescore", url?: string) {
  const { user } = await requireUser();
  const db = adminClient();
  const q = await quotaFor(db, user.id);
  if (q.runsToday >= q.maxRunsPerDay) back("runs", { error: `Daily run limit reached (${q.maxRunsPerDay}). Try again tomorrow.` });
  const { data, error } = await db.from("runs").insert({ user_id: user.id, trigger, adhoc_url: url ?? null }).select("id").single();
  if (error) back("runs", { error: error.message });
  try {
    await dispatchRun(data!.id);
  } catch (e) {
    await db.from("runs").update({ status: "failed", error: (e as Error).message }).eq("id", data!.id);
    back("runs", { error: (e as Error).message });
  }
  back("apply", { ok: "Run started. Watch it live below (cloud runs take ~30 s to start)." });
}

export async function runUrl(form: FormData) {
  const url = String(form.get("url") ?? "").trim();
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw 0;
  } catch {
    back("runs", { error: "Enter a full http(s) URL." });
  }
  await queueRun("adhoc", url);
}

export async function runSaved() {
  await queueRun("schedule");
}

export async function rescore() {
  await queueRun("rescore");
}

export async function addCompany(form: FormData) {
  const { supabase, user } = await requireUser();
  const url = String(form.get("url") ?? "").trim();
  let d: ReturnType<typeof detectSource>;
  try {
    d = detectSource(url);
  } catch {
    back("companies", { error: "Enter the company's careers page URL." });
  }
  const name = String(form.get("name") ?? "").trim() || d!.name;
  // `sources` is shared and server-written; reuse an existing row for the same careers URL.
  const db = adminClient();
  await db.from("sources").upsert({ name, careers_url: d!.careers_url, provider: d!.provider, provider_ref: d!.provider_ref }, { onConflict: "careers_url", ignoreDuplicates: true });
  const { data: src } = await db.from("sources").select("id, name").eq("careers_url", d!.careers_url).single();
  const { error } = await supabase.from("saved_companies").upsert({ user_id: user.id, source_id: src!.id, active: true }, { onConflict: "user_id,source_id" });
  if (error) back("companies", { error: error.message });
  back("companies", { ok: `Added ${src!.name}.` }); // shared rows keep their existing name; users can't rename them for others
}

export async function setCompanyActive(id: string, active: boolean) {
  const { supabase } = await requireUser();
  await supabase.from("saved_companies").update({ active }).eq("id", id);
  revalidatePath("/dashboard");
}

export async function removeCompany(id: string) {
  const { supabase } = await requireUser();
  await supabase.from("saved_companies").delete().eq("id", id);
  revalidatePath("/dashboard");
}

/** Save answers to a job's missing form questions; if nothing required is left, the job becomes ready to submit. */
export async function answerQuestions(userJobId: string, form: FormData) {
  const { supabase, user } = await requireUser();
  const { data: uj } = await supabase.from("user_jobs").select("id, status, jobs(ats_questions)").eq("id", userJobId).single();
  if (!uj || uj.status !== "needs_input") back("apply", { error: "That job no longer needs input." });
  const questions = ((uj as any).jobs?.ats_questions ?? []) as { label: string; required: boolean }[];

  const rows = questions
    .map((q) => ({ label: q.label, answer: String(form.get(q.label) ?? "").trim() }))
    .filter((q) => q.answer)
    .map((q) => ({ user_id: user.id, question_key: questionKey(q.label), question_label: q.label, answer: q.answer, source: "form", updated_at: new Date().toISOString() }));
  if (rows.length) await supabase.from("answer_bank").upsert(rows, { onConflict: "user_id,question_key" });

  const { data: bank } = await supabase.from("answer_bank").select("question_key");
  const missing = missingAnswers(questions, new Set((bank ?? []).map((b) => b.question_key)));
  // user_jobs is worker-owned; ownership was checked by the RLS-scoped read above.
  await adminClient().from("user_jobs").update(missing.length
    ? { reason_text: "Answers needed: " + missing.map((m) => m.label).join("; ") }
    : { status: "ready_to_submit", reason_text: null, updated_at: new Date().toISOString() }).eq("id", userJobId).eq("user_id", user.id);
  back("apply", missing.length ? { error: `Still needed: ${missing.map((m) => m.label).join("; ")}` } : { ok: "Saved. The job is ready to submit." });
}
