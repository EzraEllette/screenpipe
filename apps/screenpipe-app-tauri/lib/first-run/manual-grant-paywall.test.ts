// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import type { AppEntitlement, AppUser } from "@/lib/app-entitlement";
import { isCardAskEligible } from "@/lib/card-ask/gating";
import { bypassesTrialActivation, isTrialActivationEligible } from "./trial-activation";

function participant(overrides: Partial<AppEntitlement> = {}): AppUser {
  return {
    id: "synthetic-participant",
    token: "synthetic-token",
    subscription_plan: "pro",
    cloud_subscribed: true,
    app_entitled: true,
    has_payment_method: false,
    entitlement_source: "manual",
    plan_expires_at: null,
    entitlement: {
      source: "manual",
      plan: "pro",
      active: true,
      status: "active",
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
      expires_at: null,
      checked_at: new Date().toISOString(),
      features: { app: true, cloud: true },
      ...overrides,
    },
  } as AppUser;
}

describe("cardless participant grants", () => {
  it("skips trial checkout and contextual card prompts during the grant", () => {
    const user = participant();
    expect(bypassesTrialActivation(user)).toBe(true);
    expect(isTrialActivationEligible(true, user, false)).toBe(false);
    expect(isCardAskEligible(user, true)).toBe(false);
  });

  it("keeps profile signup trials in the existing card flow", () => {
    const expires = new Date(Date.now() + 7 * 86400000).toISOString();
    const user = { ...participant({ current_period_end: null, expires_at: expires }), plan_expires_at: expires };
    expect(bypassesTrialActivation(user)).toBe(false);
    expect(isCardAskEligible(user, true)).toBe(true);
  });

  it.each<Partial<AppEntitlement>>([
    { active: false },
    { current_period_end: new Date(0).toISOString() },
    { current_period_end: "invalid" },
    { current_period_end: null },
    { checked_at: new Date(0).toISOString() },
    { features: { app: false, cloud: false } },
    { source: "none" },
  ])("does not exempt invalid or expired grants: %j", (overrides) => {
    expect(bypassesTrialActivation(participant(overrides))).toBe(false);
    expect(isCardAskEligible(participant(overrides), true)).toBe(true);
  });
});
