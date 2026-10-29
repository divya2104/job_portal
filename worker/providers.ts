// Discovery providers (BACKEND_BLUEPRINT.md §3). Public ATS JSON APIs first; Firecrawl only as a fallback (D3).
import { htmlToText } from "../lib/text.ts";
import { http, httpJson, HttpError, robotsAllowed } from "./http.ts";
import { extractPosting } from "./llm.ts";

export type Salary = { min: number | null; max: number | null; currency: string | null };
export type Posting = {
  apply_url: string;
  source_url: string; // identity URL (dedup key source)
  external_id: string | null;
  requisition_id: string | null;
  company: string;
  title: string;
  location: string | null;
  work_mode: "remote" | "hybrid" | "onsite" | null;
  posted_at: string | null;
  jd_text: string | null;
  salary: Salary | null;
  liveness: "live" | "expired" | "uncertain";
  needsDetail?: boolean; // list entry without a description yet
  ref?: string; // provider-specific handle for detail()
};

export type Source = { id: string; name: string; careers_url: string; provider: string; provider_ref: string | null; max_pages: number };
export type Ctx = { searchTerms: string[]; maxPages: number; credits: { firecrawl: number }; usage: (u: { model: string; input: number; output: number }) => void };

type Provider = {
  list(src: Source, ctx: Ctx): Promise<Posting[]>;
  detail(src: Source, p: Posting, ctx: Ctx): Promise<Posting>;
};

export class BlockedError extends Error {}
export const NOT_A_POSTING = "(not a job posting)";
export class RobotsError extends Error {}

function workMode(...texts: (string | null | undefined)[]): Posting["work_mode"] {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\bremote\b|work from home/.test(t)) return "remote";
  if (/on-?site|in[- ]office/.test(t)) return "onsite";
  return null;
}
const iso = (v: string | number | null | undefined) => (v ? new Date(v).toISOString() : null);
const noDetail = async (_: Source, p: Posting) => p;

const greenhouse: Provider = {
  async list(src) {
    const d = await httpJson<{ jobs: any[] }>(`https://boards-api.greenhouse.io/v1/boards/${src.provider_ref}/jobs?content=true`);
    return d.jobs.map((j) => {
      const loc = j.location?.name ?? null;
      const jd = htmlToText(j.content);
      return {
        apply_url: j.absolute_url, source_url: j.absolute_url, external_id: String(j.id),
        requisition_id: j.requisition_id ?? null, company: src.name, title: j.title, location: loc,
        work_mode: workMode(loc), posted_at: iso(j.first_published), jd_text: jd, salary: null, liveness: "live" as const,
      };
    });
  },
  detail: noDetail,
};

const lever: Provider = {
  async list(src) {
    const d = await httpJson<any[]>(`https://api.lever.co/v0/postings/${src.provider_ref}?mode=json`);
    return d.map((j) => {
      const jd = [j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join("\n\n");
      const loc = j.categories?.allLocations?.join("; ") || j.categories?.location || null;
      const sr = j.salaryRange;
      return {
        apply_url: j.applyUrl ?? j.hostedUrl, source_url: j.hostedUrl, external_id: j.id, requisition_id: null,
        company: src.name, title: j.text, location: loc,
        work_mode: j.workplaceType && j.workplaceType !== "unspecified" ? j.workplaceType : workMode(loc),
        posted_at: iso(j.createdAt), jd_text: jd,
        salary: sr && sr.interval?.startsWith("per-year") ? { min: sr.min ?? null, max: sr.max ?? null, currency: sr.currency ?? null } : null,
        liveness: "live" as const,
      };
    });
  },
  detail: noDetail,
};

const ashby: Provider = {
  async list(src) {
    const d = await httpJson<{ jobs: any[] }>(`https://api.ashbyhq.com/posting-api/job-board/${src.provider_ref}?includeCompensation=true`);
    return d.jobs.filter((j) => j.isListed !== false).map((j) => {
      const loc = [j.location, ...(j.secondaryLocations ?? []).map((s: any) => s.location)].filter(Boolean).join("; ") || null;
      const comp = j.compensation?.summaryComponents?.find((c: any) => c.compensationType === "Salary" && /YEAR/i.test(c.interval ?? ""));
      return {
        apply_url: j.applyUrl ?? j.jobUrl, source_url: j.jobUrl, external_id: j.id, requisition_id: null,
        company: src.name, title: j.title, location: loc,
        work_mode: j.isRemote ? "remote" : workMode(j.workplaceType, loc),
        posted_at: iso(j.publishedAt), jd_text: j.descriptionPlain ?? htmlToText(j.descriptionHtml),
        salary: comp ? { min: comp.minValue ?? null, max: comp.maxValue ?? null, currency: comp.currencyCode ?? null } : null,
        liveness: "live" as const,
      };
    });
  },
  detail: noDetail,
};

const smartrecruiters: Provider = {
  async list(src, ctx) {
    const out: Posting[] = [];
    for (let page = 0; page < ctx.maxPages; page++) {
      const d = await httpJson<{ totalFound: number; content: any[] }>(
        `https://api.smartrecruiters.com/v1/companies/${src.provider_ref}/postings?limit=100&offset=${page * 100}`);
      for (const j of d.content) {
        const loc = [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(", ") || null;
        const url = `https://jobs.smartrecruiters.com/${src.provider_ref}/${j.id}`;
        out.push({
          apply_url: url, source_url: url, external_id: j.id, requisition_id: j.refNumber ?? null,
          company: src.name, title: j.name, location: loc,
          work_mode: j.location?.remote ? "remote" : j.location?.hybrid ? "hybrid" : workMode(loc),
          posted_at: iso(j.releasedDate), jd_text: null, salary: null, liveness: "live", needsDetail: true, ref: j.ref,
        });
      }
      if ((page + 1) * 100 >= d.totalFound || d.content.length === 0) break;
    }
    return out;
  },
  async detail(_src, p) {
    const d = await httpJson<any>(p.ref!);
    const s = d.jobAd?.sections ?? {};
    const jd = [s.jobDescription, s.qualifications, s.additionalInformation].map((x: any) => htmlToText(x?.text)).filter(Boolean).join("\n\n");
    return { ...p, jd_text: jd, apply_url: d.applyUrl ?? p.apply_url, needsDetail: false };
  },
};

function workdayParts(src: Source) {
  const [tenant, wd, site] = src.provider_ref!.split("/");
  const host = `${tenant}.${wd}.myworkdayjobs.com`;
  return { host, api: `https://${host}/wday/cxs/${tenant}/${site}`, site };
}

const workday: Provider = {
  async list(src, ctx) {
    const { host, api, site } = workdayParts(src);
    const seen = new Map<string, Posting>();
    for (const searchText of ctx.searchTerms.length ? ctx.searchTerms : [""]) {
      for (let page = 0; page < ctx.maxPages; page++) {
        const res = await http(`${api}/jobs`, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText }),
        });
        if (!res.ok) throw new HttpError(res.status, `${api}/jobs`);
        if (!(res.headers.get("content-type") ?? "").includes("json")) throw new BlockedError("Workday returned a non-JSON page (maintenance or bot check)");
        const d = (await res.json()) as { jobPostings?: any[] };
        const posts = d.jobPostings ?? [];
        for (const j of posts) {
          const url = `https://${host}/${site}${j.externalPath}`;
          seen.set(url, {
            apply_url: url, source_url: url, external_id: j.externalPath, requisition_id: j.bulletFields?.[0] ?? null,
            company: src.name, title: j.title, location: j.locationsText ?? null, work_mode: workMode(j.locationsText),
            posted_at: null, jd_text: null, salary: null, liveness: "live", needsDetail: true, ref: j.externalPath,
          });
        }
        if (posts.length < 20) break;
      }
    }
    return [...seen.values()];
  },
  async detail(src, p) {
    const { api } = workdayParts(src);
    const d = await httpJson<any>(`${api}${p.ref}`, { headers: { accept: "application/json" } });
    const i = d.jobPostingInfo ?? {};
    const loc = [i.location, ...(i.additionalLocations ?? [])].filter(Boolean).join("; ") || p.location;
    return {
      ...p, jd_text: htmlToText(i.jobDescription), location: loc, requisition_id: i.jobReqId ?? p.requisition_id,
      work_mode: workMode(i.remoteType, loc) ?? p.work_mode, posted_at: iso(i.startDate), needsDetail: false,
    };
  },
};

// ───────────── Firecrawl fallback ─────────────

const EXPIRED = /no longer (available|accepting applications|open)|position has been filled|this job has expired|job (is )?closed|page not found|job not found/i;
const JOBISH = /\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|requisitions?|roles?)\b/i;

async function firecrawl(path: string, body: object, ctx: Ctx) {
  if (!process.env.FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY is not set; this source needs Firecrawl.");
  const res = await http(`https://api.firecrawl.dev/v2/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (res.status === 402) throw new Error("Firecrawl credits exhausted");
  if (!res.ok) throw new HttpError(res.status, `firecrawl ${path}`);
  ctx.credits.firecrawl += 1;
  return (await res.json()) as any;
}

export const firecrawlProvider: Provider = {
  async list(src, ctx) {
    if (!(await robotsAllowed(src.careers_url))) throw new RobotsError(`robots.txt disallows ${src.careers_url}`);
    const d = await firecrawl("map", { url: src.careers_url, search: ctx.searchTerms.join(" ") || undefined, limit: 500 }, ctx);
    const links: { url: string; title?: string }[] = (d.links ?? []).map((l: any) => (typeof l === "string" ? { url: l } : l));
    const terms = ctx.searchTerms.map((t) => t.toLowerCase());
    return links
      .filter((l) => JOBISH.test(l.url) || terms.some((t) => (l.title ?? "").toLowerCase().includes(t)))
      .slice(0, src.max_pages)
      .map((l) => ({
        apply_url: l.url, source_url: l.url, external_id: null, requisition_id: null, company: src.name,
        title: l.title ?? "", location: null, work_mode: null, posted_at: null, jd_text: null, salary: null,
        liveness: "uncertain" as const, needsDetail: true,
      }));
  },
  async detail(src, p, ctx) {
    if (!(await robotsAllowed(p.source_url))) throw new RobotsError(`robots.txt disallows ${p.source_url}`);
    const d = await firecrawl("scrape", { url: p.source_url, formats: ["markdown"], onlyMainContent: true }, ctx);
    const status: number = d.data?.metadata?.statusCode ?? 200;
    const md: string = d.data?.markdown ?? "";
    if (status === 404 || status === 410 || EXPIRED.test(md.slice(0, 3000))) return { ...p, liveness: "expired", needsDetail: false };
    if (status === 403 || md.length < 300) return { ...p, liveness: "uncertain", needsDetail: false };
    const x = await extractPosting(md, ctx.usage);
    if (!x.is_job_posting) return { ...p, title: NOT_A_POSTING, liveness: "uncertain", needsDetail: false };
    return {
      ...p, title: x.title || p.title, company: x.company || src.name, location: x.location, work_mode: x.work_mode,
      posted_at: x.posted_at && !isNaN(Date.parse(x.posted_at)) ? iso(x.posted_at) : null,
      apply_url: x.apply_url && /^https?:/.test(x.apply_url) ? x.apply_url : p.apply_url,
      salary: x.salary_min || x.salary_max ? { min: x.salary_min, max: x.salary_max, currency: x.salary_currency } : null,
      jd_text: md.slice(0, 30000), liveness: x.has_apply_control ? "live" : "uncertain", needsDetail: false,
    };
  },
};

export const PROVIDERS: Record<string, Provider> = { greenhouse, lever, ashby, smartrecruiters, workday, firecrawl: firecrawlProvider };

/** Map a pasted URL to a provider + ref, plus a posting id if it points at one posting. */
export function detectSource(raw: string): { provider: string; provider_ref: string | null; careers_url: string; name: string; postingId: string | null } {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const gh = host.match(/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/);
  if (gh && parts[0]) return { provider: "greenhouse", provider_ref: parts[0], careers_url: `https://${host}/${parts[0]}`, name: parts[0], postingId: parts[1] === "jobs" ? parts[2] ?? null : null };
  if (host === "jobs.lever.co" && parts[0]) return { provider: "lever", provider_ref: parts[0], careers_url: `https://jobs.lever.co/${parts[0]}`, name: parts[0], postingId: parts[1] ?? null };
  if (host === "jobs.ashbyhq.com" && parts[0]) return { provider: "ashby", provider_ref: parts[0], careers_url: `https://jobs.ashbyhq.com/${parts[0]}`, name: parts[0], postingId: parts[1] ?? null };
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && parts[0]) return { provider: "smartrecruiters", provider_ref: parts[0], careers_url: `https://careers.smartrecruiters.com/${parts[0]}`, name: parts[0], postingId: parts[1]?.split("-")[0] ?? null };
  const wd = host.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const site = rest[0];
    const jobIdx = rest.indexOf("job");
    return { provider: "workday", provider_ref: `${wd[1]}/${wd[2]}/${site}`, careers_url: `https://${host}/${site}`, name: wd[1], postingId: jobIdx > 0 ? "/" + rest.slice(jobIdx).join("/") : null };
  }
  return { provider: "firecrawl", provider_ref: null, careers_url: raw, name: host.replace(/^www\./, ""), postingId: null };
}
