// Proves user A cannot read or write user B's data (PLAN.md §2, §14 Phase 2).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { admin, dropUser, makeUser } from "./helpers";

let A: Awaited<ReturnType<typeof makeUser>>, B: Awaited<ReturnType<typeof makeUser>>, ADM: Awaited<ReturnType<typeof makeUser>>;
const bPath = () => `${B.id}/cv.pdf`;
let bJobId: string, bUserJobId: string, bRunId: string;

beforeAll(async () => {
  [A, B, ADM] = await Promise.all([makeUser("a"), makeUser("b"), makeUser("adm")]);
  await admin.from("profiles").update({ is_admin: true }).eq("user_id", ADM.id);

  // Seed B's data the way the app / worker would.
  const ok = (r: { error: unknown }) => { if (r.error) throw r.error; };
  ok(await B.db.storage.from("cvs").upload(bPath(), new Uint8Array([37, 80, 68, 70]), { contentType: "application/pdf" }));
  ok(await B.db.from("cvs").insert({ user_id: B.id, storage_path: bPath(), file_name: "b.pdf", parsed: { skills: ["secret-skill"] }, text: "B's private CV text" }));
  ok(await B.db.from("answer_bank").insert({ user_id: B.id, question_key: "phone", question_label: "Phone", answer: "+91 99999", source: "onboarding" }));
  const { data: src } = await admin.from("sources").select("id").limit(1).single();
  ok(await B.db.from("saved_companies").insert({ user_id: B.id, source_id: src!.id }));
  bRunId = randomUUID();
  ok(await admin.from("runs").insert({ id: bRunId, user_id: B.id, trigger: "adhoc" }));
  const { data: job } = await admin.from("jobs").insert({ url_key: `test/${randomUUID()}`, apply_url: "https://x.test/apply", title: "PM" }).select("id").single();
  bJobId = job!.id;
  const { data: uj } = await admin.from("user_jobs").insert({ user_id: B.id, job_id: bJobId, status: "apply", total: 4.2 }).select("id").single();
  bUserJobId = uj!.id;
  ok(await admin.from("events").insert({ user_id: B.id, run_id: bRunId, stage: "route", kind: "apply" }));
  ok(await admin.from("applications").insert({ user_id: B.id, user_job_id: bUserJobId }));
  ok(await admin.from("usage_ledger").insert({ user_id: B.id, run_id: bRunId, kind: "llm_input_tokens", units: 100 }));
  ok(await admin.from("run_sources").insert({ run_id: bRunId, source_id: src!.id, user_id: B.id, status: "ok" }));
});

afterAll(async () => {
  await Promise.all([A, B, ADM].filter(Boolean).map((u) => dropUser(u.id)));
  if (bJobId) await admin.from("jobs").delete().eq("id", bJobId);
});

describe("user A cannot read user B's data", () => {
  const tables = ["profiles", "cvs", "answer_bank", "saved_companies", "runs", "run_sources", "user_jobs", "jobs", "events", "applications", "usage_ledger", "user_limits"];

  it.each(tables)("%s: sees none of B's rows", async (table) => {
    const col = table === "jobs" ? "id" : "user_id";
    const val = table === "jobs" ? bJobId : B.id;
    const { data, error } = await A.db.from(table).select("*").eq(col, val);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("B can read its own rows (sanity check that data exists)", async () => {
    expect((await B.db.from("cvs").select("id")).data).toHaveLength(1);
    expect((await B.db.from("user_jobs").select("id")).data).toHaveLength(1);
    expect((await B.db.from("jobs").select("id").eq("id", bJobId)).data).toHaveLength(1);
  });

  it("cannot download B's CV file", async () => {
    const { data, error } = await A.db.storage.from("cvs").download(bPath());
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    const list = await A.db.storage.from("cvs").list(B.id);
    expect(list.data ?? []).toEqual([]);
  });
});

describe("user A cannot write user B's data", () => {
  it("cannot insert rows owned by B", async () => {
    const r = await A.db.from("answer_bank").insert({ user_id: B.id, question_key: "x", question_label: "x", answer: "x", source: "form" });
    expect(r.error).not.toBeNull();
  });

  it("cannot update or delete B's rows (0 rows affected)", async () => {
    await A.db.from("profiles").update({ cities: ["Hacked"] }).eq("user_id", B.id);
    await A.db.from("answer_bank").delete().eq("user_id", B.id);
    const { data: p } = await admin.from("profiles").select("cities").eq("user_id", B.id).single();
    expect(p!.cities).not.toContain("Hacked");
    expect((await admin.from("answer_bank").select("id").eq("user_id", B.id)).data).toHaveLength(1);
  });

  it("cannot upload into B's storage folder", async () => {
    const { error } = await A.db.storage.from("cvs").upload(`${B.id}/evil.pdf`, new Uint8Array([1]));
    expect(error).not.toBeNull();
  });
});

describe("privilege boundaries", () => {
  it("a user cannot make themselves admin", async () => {
    const { error } = await A.db.from("profiles").update({ is_admin: true }).eq("user_id", A.id);
    expect(error).not.toBeNull();
    const { data } = await admin.from("profiles").select("is_admin").eq("user_id", A.id).single();
    expect(data!.is_admin).toBe(false);
  });

  it("users cannot write worker-owned tables", async () => {
    expect((await A.db.from("runs").insert({ user_id: A.id, trigger: "adhoc" })).error).not.toBeNull();
    expect((await A.db.from("user_jobs").insert({ user_id: A.id, job_id: bJobId, status: "apply" })).error).not.toBeNull();
    expect((await A.db.from("events").insert({ user_id: A.id, stage: "x", kind: "x" })).error).not.toBeNull();
  });

  it("non-admins cannot see or edit the invite list or settings", async () => {
    expect((await A.db.from("allowed_emails").select("*")).data).toEqual([]);
    expect((await A.db.from("allowed_emails").insert({ email: "x@test.local" })).error).not.toBeNull();
    await A.db.from("app_settings").update({ max_users: 999 }).eq("id", true);
    expect((await admin.from("app_settings").select("max_users").single()).data!.max_users).not.toBe(999);
  });

  it("the admin can see B's profile and runs but NOT B's CV or answers", async () => {
    expect((await ADM.db.from("profiles").select("user_id").eq("user_id", B.id)).data).toHaveLength(1);
    expect((await ADM.db.from("runs").select("id").eq("user_id", B.id)).data).toHaveLength(1);
    expect((await ADM.db.from("cvs").select("id").eq("user_id", B.id)).data).toEqual([]);
    expect((await ADM.db.from("answer_bank").select("id").eq("user_id", B.id)).data).toEqual([]);
    expect((await ADM.db.storage.from("cvs").download(bPath())).data).toBeNull();
  });
});
