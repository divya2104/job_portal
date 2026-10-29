import { describe, expect, it } from "vitest";
import { computeTotal, EvalOutput, route, validateEval, withOneRetry } from "@/lib/scoring";
import { evalFixture } from "./helpers";

describe("routing boundaries (D2)", () => {
  it.each([
    [3.49, "discarded"], [3.5, "review"], [3.99, "review"], [4.0, "apply"], [4.01, "apply"], [0, "discarded"], [5, "apply"],
  ] as const)("%s → %s", (total, expected) => expect(route(total)).toBe(expected));
});

describe("total", () => {
  it("is the weighted mean (PLAN.md §6 example = 4.06)", () => {
    expect(computeTotal(evalFixture([4.0, 3.5, 4.5, 5.0, null]))).toBe(4.06);
  });
  it("renormalises weights when a criterion is null (missing data never lowers the score)", () => {
    expect(computeTotal(evalFixture([4, 4, 4, 4, null]))).toBe(4);
    expect(computeTotal(evalFixture([4, 4, 4, 4, 0]))).toBe(3.6);
  });
  it("caps at 1.0 when the role family doesn't match", () => {
    expect(computeTotal(evalFixture([5, 5, 5, 5, 5], false))).toBe(1);
  });
});

describe("JSON validation + one retry", () => {
  it("rejects malformed output", () => {
    expect(() => EvalOutput.parse({ criteria: {} })).toThrow();
    expect(() => validateEval(evalFixture([7, 3, 3, 3, 3]))).toThrow(/between 0 and 5/);
    expect(() => validateEval(evalFixture([null, null, null, null, null]))).toThrow(/at least one/);
  });

  it("retries once, feeding the error back", async () => {
    const seen: (string | undefined)[] = [];
    const r = await withOneRetry(async (prev) => {
      seen.push(prev);
      if (!prev) throw new Error("criteria.skills_match.score must be between 0 and 5 or null, got 7");
      return "ok";
    });
    expect(r).toEqual({ ok: true, value: "ok" });
    expect(seen).toEqual([undefined, "criteria.skills_match.score must be between 0 and 5 or null, got 7"]);
  });

  it("gives up after the second invalid answer (→ eval_failed)", async () => {
    let calls = 0;
    const r = await withOneRetry(async () => {
      calls++;
      throw new Error("output did not match the schema");
    });
    expect(calls).toBe(2);
    expect(r).toEqual({ ok: false, error: "output did not match the schema" });
  });
});
