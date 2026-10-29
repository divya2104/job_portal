// Live UI isolation: a subscriber receives only their own runs/events, even with no filter on the channel.
import { afterAll, beforeAll, expect, it } from "vitest";
import { admin, dropUser, makeUser } from "./helpers";

let A: Awaited<ReturnType<typeof makeUser>>, B: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => { [A, B] = await Promise.all([makeUser("rt-a"), makeUser("rt-b")]); });
afterAll(async () => { await Promise.all([A, B].filter(Boolean).map((u) => dropUser(u.id))); });

it("B's realtime stream contains B's events and runs but never A's", async () => {
  const received: { table: string; user_id: string }[] = [];
  const channel = B.db.channel("iso-test")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, (p) => received.push({ table: "events", user_id: (p.new as any).user_id }))
    .on("postgres_changes", { event: "*", schema: "public", table: "runs" }, (p) => received.push({ table: "runs", user_id: (p.new as any).user_id }));
  // SUBSCRIBED fires before the database subscription is live; wait for Supabase's own confirmation.
  await new Promise<void>((resolve, reject) => {
    channel.on("system", {}, (m: any) => /Subscribed to PostgreSQL/i.test(m.message ?? "") && resolve());
    channel.subscribe((s) => s === "CHANNEL_ERROR" && reject(new Error(s)));
  });

  for (const u of [A, B, A]) {
    const { data: run } = await admin.from("runs").insert({ user_id: u.id, trigger: "adhoc" }).select("id").single();
    await admin.from("events").insert({ user_id: u.id, run_id: run!.id, stage: "discover", kind: "job", payload: { title: "secret-" + u.id } });
    await admin.from("runs").update({ counts: { discovered: 1 } }).eq("id", run!.id);
  }
  // B should get: runs insert, events insert, runs update.
  for (let i = 0; i < 50 && received.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1000)); // allow any leaked A rows to arrive
  await B.db.removeChannel(channel);

  expect(received.length).toBe(3);
  expect(received.every((r) => r.user_id === B.id)).toBe(true);
}, 30000);
