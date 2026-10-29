// Pipeline CLI. Same entry point for local runs and the scheduled GitHub Actions job.
//   npm run pipeline -- --all                          scheduled batch: every onboarded user
//   npm run pipeline -- --user <email> [--url <url>]   one user's saved companies, or one ad-hoc URL
//   npm run pipeline -- --user <email> --rescore       re-score stale jobs after a profile change
//   npm run pipeline -- --run <run_id>                 a run queued by the dashboard
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { createRun, reapStale, runBatch, runUser } from "./pipeline.ts";

const { values: a } = parseArgs({
  options: { all: { type: "boolean" }, user: { type: "string", multiple: true }, url: { type: "string" }, rescore: { type: "boolean" }, run: { type: "string" } },
});

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function userId(email: string) {
  const { data } = await db.from("profiles").select("user_id").eq("email", email.toLowerCase()).maybeSingle();
  if (!data) throw new Error(`No user with email ${email}`);
  return data.user_id as string;
}

async function summary(runIds: string[]) {
  const { data: runs } = await db.from("runs").select("id, user_id, status, counts, error").in("id", runIds);
  const { data: users } = await db.from("profiles").select("user_id, email").in("user_id", (runs ?? []).map((r) => r.user_id));
  const email = new Map((users ?? []).map((u) => [u.user_id, u.email]));
  for (const r of runs ?? []) console.log(`${email.get(r.user_id)}  ${r.status}  ${JSON.stringify(r.counts)}${r.error ? "  error: " + r.error : ""}`);
}

if (a.all) {
  const { runIds } = await runBatch(db);
  console.log(`Batch finished: ${runIds.length} user run(s)`);
  await summary(runIds);
} else if (a.run) {
  await reapStale(db);
  await runUser(db, a.run);
  await summary([a.run]);
} else if (a.user?.length) {
  await reapStale(db);
  const ids: string[] = [];
  for (const email of a.user) {
    const id = await createRun(db, await userId(email), a.rescore ? "rescore" : a.url ? "adhoc" : "schedule", { url: a.url });
    await runUser(db, id);
    ids.push(id);
  }
  await summary(ids);
} else {
  console.error("Usage: --all | --user <email> [--url <url>] [--rescore] | --run <id>");
  process.exit(1);
}
