import { requireUser } from "@/lib/supabase";
import type { ParsedCv } from "@/lib/cv";

/** Everything the onboarding / settings forms need for the signed-in user (RLS-scoped). */
export async function loadProfileData() {
  const { supabase, user, profile } = await requireUser();
  const [cvs, answers, sources, saved] = await Promise.all([
    supabase.from("cvs").select("id, file_name, parsed, is_active, confirmed_at, created_at").order("created_at", { ascending: false }),
    supabase.from("answer_bank").select("question_key, answer"),
    supabase.from("sources").select("id, name, provider, is_starter").order("name"),
    supabase.from("saved_companies").select("source_id").eq("active", true),
  ]);
  const allCvs = (cvs.data ?? []) as { id: string; file_name: string; parsed: ParsedCv; is_active: boolean; confirmed_at: string | null }[];
  const activeCv = allCvs.find((c) => c.is_active) ?? null;
  const pendingCv = allCvs.find((c) => !c.confirmed_at) ?? null; // uploaded, not yet confirmed
  const savedIds = new Set((saved.data ?? []).map((s) => s.source_id as string));
  return {
    user,
    profile,
    activeCv,
    pendingCv,
    answers: Object.fromEntries((answers.data ?? []).map((a) => [a.question_key, a.answer])) as Record<string, string>,
    // starter list plus any company the user saved
    sources: (sources.data ?? []).filter((s) => s.is_starter || savedIds.has(s.id)),
    savedIds,
  };
}
