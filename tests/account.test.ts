import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createAccount, deleteAccount, resetPassword } from "@/lib/account";
import { admin, dropUser, makeUser } from "./helpers";

const anon = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
let originalMax: number;
const created: string[] = [];

beforeAll(async () => {
  originalMax = (await admin.from("app_settings").select("max_users").single()).data!.max_users;
  await admin.from("app_settings").update({ max_users: 1000 }).eq("id", true);
});
afterAll(async () => {
  await admin.from("app_settings").update({ max_users: originalMax }).eq("id", true);
  await Promise.all(created.map(dropUser));
});

describe("sign up with generated password", () => {
  it("rejects an email that is not on the invite list", async () => {
    await expect(createAccount(admin, `nobody-${randomUUID()}@test.local`)).rejects.toThrow(/invite list/);
  });

  it("creates an invited account whose generated password works, and stores no plain password", async () => {
    const email = `invited-${randomUUID().slice(0, 8)}@test.local`;
    await admin.from("allowed_emails").insert({ email });
    const { password } = await createAccount(admin, email.toUpperCase()); // normalised to lower case
    expect(password).toMatch(/^[A-Za-z0-9_-]{20}$/);

    const { data, error } = await anon().auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
    created.push(data.user!.id);

    const { data: prof } = await admin.from("profiles").select("*").eq("user_id", data.user!.id).single();
    expect(JSON.stringify(prof)).not.toContain(password);
    expect(prof!.onboarded_at).toBeNull(); // first login → onboarding
    await admin.from("allowed_emails").delete().eq("email", email);
  });

  it("refuses a second account for the same email", async () => {
    const email = `dupe-${randomUUID().slice(0, 8)}@test.local`;
    await admin.from("allowed_emails").insert({ email });
    const { password } = await createAccount(admin, email);
    created.push((await anon().auth.signInWithPassword({ email, password })).data.user!.id);
    await expect(createAccount(admin, email)).rejects.toThrow(/already exists/);
    await admin.from("allowed_emails").delete().eq("email", email);
  });

  it("enforces the configurable user limit", async () => {
    const { count } = await admin.from("profiles").select("*", { count: "exact", head: true });
    await admin.from("app_settings").update({ max_users: count }).eq("id", true);
    const email = `over-${randomUUID().slice(0, 8)}@test.local`;
    await admin.from("allowed_emails").insert({ email });
    await expect(createAccount(admin, email)).rejects.toThrow(/user limit/);
    await admin.from("allowed_emails").delete().eq("email", email);
    await admin.from("app_settings").update({ max_users: 1000 }).eq("id", true);
  });

  it("public sign-up through the auth API is disabled", async () => {
    const { error } = await anon().auth.signUp({ email: `direct-${randomUUID()}@test.local`, password: "x".repeat(20) });
    expect(error).not.toBeNull();
  });

  it("admin password reset replaces the old password", async () => {
    const u = await makeUser("reset");
    created.push(u.id);
    const newPw = await resetPassword(admin, u.id);
    expect((await anon().auth.signInWithPassword({ email: u.email, password: newPw })).error).toBeNull();
  });
});

describe("delete my account and data", () => {
  it("removes the CV file, profile and every user-owned row", async () => {
    const u = await makeUser("del");
    await u.db.storage.from("cvs").upload(`${u.id}/cv.pdf`, new Uint8Array([1, 2, 3]));
    await u.db.from("cvs").insert({ user_id: u.id, storage_path: `${u.id}/cv.pdf`, file_name: "cv.pdf", parsed: {}, text: "t" });
    await u.db.from("answer_bank").insert({ user_id: u.id, question_key: "k", question_label: "k", answer: "a", source: "onboarding" });
    await admin.from("runs").insert({ user_id: u.id, trigger: "adhoc" });

    await deleteAccount(admin, u.id);

    for (const t of ["profiles", "cvs", "answer_bank", "runs", "user_limits", "saved_companies"])
      expect((await admin.from(t).select("user_id").eq("user_id", u.id)).data, t).toEqual([]);
    expect((await admin.storage.from("cvs").list(u.id)).data).toEqual([]);
    expect((await admin.auth.admin.getUserById(u.id)).data.user).toBeNull();
  });
});
