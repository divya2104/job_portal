import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import mammoth from "mammoth";
import { extractText as pdfText } from "unpdf";

export const SENIORITY = ["intern", "junior", "mid", "senior", "lead", "manager", "director", "executive"] as const;

export const ParsedCv = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  linkedin: z.string().nullable(),
  skills: z.array(z.string()),
  total_years: z.number(),
  seniority: z.enum(SENIORITY),
  domains: z.array(z.string()),
  education: z.array(z.object({ degree: z.string(), institution: z.string(), year: z.string().nullable() })),
});
export type ParsedCv = z.infer<typeof ParsedCv>;

const Keywords = z.object({ positive: z.array(z.string()), negative: z.array(z.string()) });
export type Keywords = z.infer<typeof Keywords>;

export const MAX_CV_BYTES = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB

export async function cvToText(bytes: Uint8Array, fileName: string): Promise<string> {
  const ext = fileName.toLowerCase().split(".").pop();
  let text: string;
  // pdf.js transfers (detaches) the buffer it gets; pass a copy so the caller can still upload the file.
  if (ext === "pdf") text = (await pdfText(bytes.slice(), { mergePages: true })).text;
  else if (ext === "docx") text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  else throw new Error("Upload a PDF or DOCX file.");
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 200) throw new Error("Couldn't read text from this file (is it a scanned image?). Upload a text-based PDF or DOCX.");
  return text;
}

function client() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env.local.");
  return new Anthropic();
}

async function structured<T extends z.ZodType>(schema: T, system: string, user: string): Promise<z.infer<T>> {
  const res = await client().messages.parse({
    model: process.env.EXTRACTION_MODEL ?? "claude-haiku-5-5",
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(schema) },
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined to process this file.");
  if (!res.parsed_output) throw new Error("The model returned an unreadable result. Try again.");
  return res.parsed_output;
}

export function parseCv(text: string) {
  return structured(
    ParsedCv,
    "Extract a structured profile from the candidate's CV. Use only facts stated in the CV; never invent. " +
      "total_years = total professional experience in years (decimals allowed), excluding education. " +
      "seniority = the level of their most recent role. Use null for fields not present.",
    `<cv>\n${text}\n</cv>`,
  );
}

/** Close-synonym titles to match listings, plus title words that signal a different role family. */
export function suggestKeywords(titles: string[]) {
  return structured(
    Keywords,
    "You help filter job listings by title. Given target job titles, return `positive`: the titles themselves plus " +
      "close synonyms and common variants (e.g. 'Product Manager' → 'Product Owner', 'APM', 'PM'), max 15, short phrases. " +
      "Return `negative`: title words that indicate a different role family or a far more senior level " +
      "(e.g. 'Engineer', 'Scientist', 'Director', 'VP'), max 12. Never put a word in negative that appears in a target title.",
    titles.join("\n"),
  );
}
