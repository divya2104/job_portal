import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { routeFor } from "@/lib/routing";

/** Refreshes the Supabase session cookie and sends users to login / onboarding / dashboard. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  let onboarded = false;
  if (data.user) {
    const { data: p } = await supabase.from("profiles").select("onboarded_at").eq("user_id", data.user.id).single();
    onboarded = !!p?.onboarded_at;
  }

  const target = routeFor(request.nextUrl.pathname, !!data.user, onboarded);
  if (!target) return response;
  const redirect = NextResponse.redirect(new URL(target, request.url));
  response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
