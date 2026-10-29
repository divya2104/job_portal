import { describe, expect, it } from "vitest";
import { routeFor } from "@/lib/routing";

describe("login → onboarding once → dashboard", () => {
  it("signed-out users go to login, except login/signup", () => {
    expect(routeFor("/dashboard", false, false)).toBe("/login");
    expect(routeFor("/onboarding", false, false)).toBe("/login");
    expect(routeFor("/login", false, false)).toBeNull();
    expect(routeFor("/signup", false, false)).toBeNull();
  });

  it("first login: everything leads to onboarding", () => {
    expect(routeFor("/login", true, false)).toBe("/onboarding");
    expect(routeFor("/", true, false)).toBe("/onboarding");
    expect(routeFor("/dashboard", true, false)).toBe("/onboarding");
    expect(routeFor("/settings", true, false)).toBe("/onboarding");
    expect(routeFor("/onboarding", true, false)).toBeNull();
  });

  it("returning users skip onboarding entirely", () => {
    expect(routeFor("/login", true, true)).toBe("/dashboard");
    expect(routeFor("/", true, true)).toBe("/dashboard");
    expect(routeFor("/onboarding", true, true)).toBe("/dashboard");
    expect(routeFor("/dashboard", true, true)).toBeNull();
    expect(routeFor("/settings", true, true)).toBeNull();
  });
});
