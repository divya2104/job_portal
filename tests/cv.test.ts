import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cvToText, parseCv } from "@/lib/cv";

const fixture = (f: string) => new Uint8Array(readFileSync(`tests/fixtures/${f}`));

describe("CV text extraction", () => {
  it.each(["cv.pdf", "cv.docx"])("reads %s", async (f) => {
    const text = await cvToText(fixture(f), f);
    expect(text).toContain("Associate Product Manager");
    expect(text).toContain("Example Lending Co");
  });

  it("leaves the caller's bytes intact so the same file can be uploaded", async () => {
    const bytes = fixture("cv.pdf");
    const size = bytes.byteLength;
    await cvToText(bytes, "cv.pdf");
    expect(bytes.byteLength).toBe(size);
  });

  it("rejects other file types and image-only files", async () => {
    await expect(cvToText(new Uint8Array([1]), "cv.png")).rejects.toThrow(/PDF or DOCX/);
    await expect(cvToText(fixture("cv.pdf").slice(0, 0), "cv.pdf")).rejects.toThrow();
  });
});

// Calls the real Anthropic API (Haiku); runs only when ANTHROPIC_API_KEY is set.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("CV parsing (live LLM)", () => {
  it("returns a structured profile grounded in the CV", async () => {
    const parsed = await parseCv(await cvToText(fixture("cv.pdf"), "cv.pdf"));
    expect(parsed.email).toBe("asha.rao@example.com");
    expect(parsed.total_years).toBeGreaterThanOrEqual(2);
    expect(parsed.total_years).toBeLessThanOrEqual(4.5);
    expect(parsed.skills.join(" ").toLowerCase()).toContain("sql");
    expect(parsed.education.length).toBe(2);
  }, 60000);
});
