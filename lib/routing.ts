const PUBLIC = ["/login", "/signup"];

/** Where a request should be redirected, or null to let it through. */
export function routeFor(path: string, signedIn: boolean, onboarded: boolean): string | null {
  const home = onboarded ? "/dashboard" : "/onboarding";
  if (!signedIn) return PUBLIC.includes(path) ? null : "/login";
  if (path === "/" || PUBLIC.includes(path)) return home;
  if (!onboarded && !path.startsWith("/onboarding")) return "/onboarding";
  if (onboarded && path.startsWith("/onboarding")) return "/dashboard";
  return null;
}
