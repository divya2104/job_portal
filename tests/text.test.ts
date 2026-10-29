import { describe, expect, it } from "vitest";
import { htmlToText, urlKey } from "@/lib/text";
import { detectSource } from "@/worker/providers";
import { questionKey } from "@/lib/questions";

describe("urlKey (dedup identity)", () => {
  it("strips tracking params, lowercases host, drops trailing slash", () => {
    expect(urlKey("https://Job-Boards.Greenhouse.io/acme/jobs/123/?utm_source=x&gh_src=y")).toBe("job-boards.greenhouse.io/acme/jobs/123");
    expect(urlKey("https://jobs.lever.co/acme/abc?lever-source=LinkedIn")).toBe("jobs.lever.co/acme/abc");
  });
  it("keeps gh_jid, the posting id on embedded Greenhouse boards", () => {
    const a = urlKey("https://www.databricks.com/company/careers/open-positions/job?gh_jid=111&gh_src=x");
    expect(a).toBe("www.databricks.com/company/careers/open-positions/job?gh_jid=111");
    expect(a).not.toBe(urlKey("https://www.databricks.com/company/careers/open-positions/job?gh_jid=222"));
  });

  it("keeps identity params and SPA routes, drops plain fragments", () => {
    expect(urlKey("https://x.com/careers?id=7#/job/42")).toBe("x.com/careers?id=7#/job/42");
    expect(urlKey("https://x.com/careers/7#apply")).toBe("x.com/careers/7");
  });
});

describe("htmlToText", () => {
  it("decodes Greenhouse's escaped HTML", () => {
    expect(htmlToText("&lt;p&gt;Own the &amp;quot;roadmap&amp;quot;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;3+ years&lt;/li&gt;&lt;/ul&gt;"))
      .toMatch(/^Own the "roadmap"\n+• 3\+ years$/);
  });
});

describe("detectSource (ad-hoc URLs)", () => {
  it("recognises ATS boards and single postings", () => {
    expect(detectSource("https://job-boards.greenhouse.io/groww/jobs/123")).toMatchObject({ provider: "greenhouse", provider_ref: "groww", postingId: "123" });
    expect(detectSource("https://jobs.lever.co/cred")).toMatchObject({ provider: "lever", provider_ref: "cred", postingId: null });
    expect(detectSource("https://jobs.ashbyhq.com/atlan/abc-def")).toMatchObject({ provider: "ashby", postingId: "abc-def" });
    expect(detectSource("https://pwc.wd3.myworkdayjobs.com/en-US/Global_Experienced_Careers/job/Mumbai/PM_123"))
      .toMatchObject({ provider: "workday", provider_ref: "pwc/wd3/Global_Experienced_Careers", postingId: "/job/Mumbai/PM_123" });
    expect(detectSource("https://careers.example.com/jobs/9")).toMatchObject({ provider: "firecrawl", postingId: null });
  });
});

describe("questionKey", () => {
  it("maps common form labels onto answer-bank keys", () => {
    expect(questionKey("First Name*")).toBe("full_name");
    expect(questionKey("LinkedIn Profile")).toBe("linkedin_url");
    expect(questionKey("Resume/CV")).toBe("__cv");
    expect(questionKey("What is your expected CTC?")).toBe("expected_ctc");
    expect(questionKey("Why do you want to join Acme?")).toBe("why_do_you_want_to_join_acme");
  });
});
