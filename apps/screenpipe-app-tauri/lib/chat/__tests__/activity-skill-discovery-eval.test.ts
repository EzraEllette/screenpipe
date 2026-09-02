// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_SKILL_DISCOVERY_EVAL_CASES,
  type ActivitySkillDiscoveryEvalCase,
  buildActivitySkillDiscoveryEvalPrompt,
  evaluateActivitySkillDiscoveryOutput,
} from "../activity-skill-discovery-eval";

function goldOutput(testCase: ActivitySkillDiscoveryEvalCase) {
  if (!testCase.expected) return { suggestions: [] };
  return {
    suggestions: [
      {
        title: testCase.expected.exampleTitle,
        description:
          testCase.id === "review-mrr-across-stripe-and-posthog"
            ? "Review MRR in Stripe and PostHog."
            : "Review and submit the weekly timesheet.",
        sessionCount: testCase.expected.episodes.length,
        episodes: testCase.expected.episodes.map((episode) => ({
          activityIds: [episode.activityId],
          evidence: episode.evidence.map((frame) => ({ ...frame })),
        })),
      },
    ],
  };
}

describe("activity skill discovery quality eval", () => {
  it("accepts the gold result for all five discovery cases", () => {
    for (const testCase of ACTIVITY_SKILL_DISCOVERY_EVAL_CASES) {
      expect(
        evaluateActivitySkillDiscoveryOutput(
          JSON.stringify(goldOutput(testCase)),
          testCase,
        ),
        testCase.id,
      ).toEqual([]);
    }
  });

  it("uses the shipped production prompt with the case range and tool fixture", () => {
    const testCase = ACTIVITY_SKILL_DISCOVERY_EVAL_CASES[0];
    const prompt = buildActivitySkillDiscoveryEvalPrompt(testCase);

    expect(prompt).toContain(
      "Discover a few high-confidence reusable skill ideas",
    );
    expect(prompt).toContain(`start_time: ${testCase.start}`);
    expect(prompt).toContain(`end_time: ${testCase.end}`);
    expect(prompt).toContain("Do not exhaustively load every Activity row");
    expect(prompt).toContain("If a multi-term query returns no Activities");
    expect(prompt).toContain(
      "one uniquely identifying outcome term copied from that title",
    );
    expect(prompt).toContain("activity-mrr-1");
    expect(prompt).not.toContain("{{START_TIME}}");
    expect(prompt).not.toContain("{{END_TIME}}");
  });

  it("rejects any suggestion for one session, pinned chrome, or project phases", () => {
    const falsePositive = {
      suggestions: [
        {
          title: "Review Stripe",
          description: "Review Stripe.",
          sessionCount: 3,
          episodes: [1, 2, 3].map((index) => ({
            activityIds: [`activity-${index}`],
            evidence: [
              {
                frameId: index,
                timestamp: `2026-08-0${index}T10:00:00Z`,
                app: "Arc",
                window: "Stripe",
                browserUrl: "https://stripe.com",
              },
            ],
          })),
        },
      ],
    };
    for (const testCase of ACTIVITY_SKILL_DISCOVERY_EVAL_CASES.filter(
      (candidate) => candidate.expected === null,
    )) {
      expect(
        evaluateActivitySkillDiscoveryOutput(
          JSON.stringify(falsePositive),
          testCase,
        ),
        testCase.id,
      ).toContain("expected no skill suggestions");
    }
  });

  it("requires the exact simple Review MRR title and complete auditable evidence", () => {
    const testCase = ACTIVITY_SKILL_DISCOVERY_EVAL_CASES[0];
    const wrongTitle = goldOutput(testCase);
    wrongTitle.suggestions[0].title = "Analyze revenue activity history";
    expect(
      evaluateActivitySkillDiscoveryOutput(
        JSON.stringify(wrongTitle),
        testCase,
      ),
    ).toContain("expected exact title Review MRR");

    const inventedFrame = goldOutput(testCase);
    inventedFrame.suggestions[0].episodes[0].evidence[0].frameId = 999999;
    expect(
      evaluateActivitySkillDiscoveryOutput(
        JSON.stringify(inventedFrame),
        testCase,
      ),
    ).toContain("missing exact frame evidence 1101 for activity-mrr-1");

    const skillDefinition = goldOutput(testCase) as any;
    skillDefinition.suggestions[0].blueprint = { steps: ["open Stripe"] };
    expect(
      evaluateActivitySkillDiscoveryOutput(
        JSON.stringify(skillDefinition),
        testCase,
      ).some((failure) => failure.includes("unsupported fields")),
    ).toBe(true);
  });

  it("requires an unfamiliar repeated procedure to be suggested by name", () => {
    const testCase = ACTIVITY_SKILL_DISCOVERY_EVAL_CASES[4];
    expect(
      evaluateActivitySkillDiscoveryOutput(
        JSON.stringify({ suggestions: [] }),
        testCase,
      ),
    ).toContain("expected exactly one skill suggestion");

    const vague = goldOutput(testCase);
    vague.suggestions[0].title = "Use Chronologix";
    expect(
      evaluateActivitySkillDiscoveryOutput(JSON.stringify(vague), testCase),
    ).toContain("title does not name the repeated procedure");
  });

  it("rejects malformed and schema-invalid model output", () => {
    const testCase = ACTIVITY_SKILL_DISCOVERY_EVAL_CASES[0];
    expect(evaluateActivitySkillDiscoveryOutput("not json", testCase)).toEqual([
      "output is not a JSON object",
    ]);
    expect(
      evaluateActivitySkillDiscoveryOutput(
        JSON.stringify({ suggestions: "Review MRR" }),
        testCase,
      ),
    ).toContain("suggestions must be an array");
  });
});
