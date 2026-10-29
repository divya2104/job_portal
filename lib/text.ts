// URL identity and text helpers shared by the worker and tests (BACKEND_BLUEPRINT.md §5).

// gh_jid is NOT tracking: embedded Greenhouse boards identify each posting by it.
const TRACKING = /^(utm_|gh_src$|fbclid$|gclid$|lever-source|lever-origin$|source$|ref$|src$|trk$|mc_)/i;

/** Dedup key: lowercase host, no tracking params, no trailing slash/dot, keep SPA routes like #/job/123. */
export function urlKey(raw: string): string {
  const u = new URL(raw.trim());
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const hash = u.hash.startsWith("#/") ? u.hash : "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const q = u.searchParams.toString();
  return `${u.hostname}${u.port ? ":" + u.port : ""}${path}${q ? "?" + q : ""}${hash}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));

/** ATS descriptions are HTML (Greenhouse double-escapes it). Good-enough plain text for filters and the LLM. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;
  if (/&lt;\w/.test(s)) s = decode(s); // escaped HTML → HTML
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/ul|\/ol|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decode(s).replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
