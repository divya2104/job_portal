// One-off: create the admin account (ADMIN_EMAIL) and print its generated password once.
// Usage: npm run create-admin
import { createClient } from "@supabase/supabase-js";
import { createAccount } from "../lib/account.ts";

const email = process.env.ADMIN_EMAIL?.toLowerCase();
if (!email) throw new Error("Set ADMIN_EMAIL in .env.local");

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

await admin.from("allowed_emails").upsert({ email });
const { password } = await createAccount(admin, email);
const { data: user } = await admin.from("profiles").select("user_id").eq("email", email).single();
await admin.from("profiles").update({ is_admin: true }).eq("user_id", user!.user_id);

console.log(`Admin account created: ${email}\nPassword (shown once, save it now): ${password}`);
