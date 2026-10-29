import { redirect } from "next/navigation";

// proxy.ts normally redirects "/" first.
export default function Home() {
  redirect("/dashboard");
}
