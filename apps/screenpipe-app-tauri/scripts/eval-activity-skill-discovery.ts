// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/**
 * Opt-in local-model eval for activity skill discovery quality.
 *
 * It sends only synthetic official-tool fixtures; no recordings or user data
 * are read.
 *
 *   ollama serve
 *   bun scripts/eval-activity-skill-discovery.ts
 *   bun scripts/eval-activity-skill-discovery.ts --model=qwen3.5:4b
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTIVITY_SKILL_DISCOVERY_EVAL_CASES,
  buildActivitySkillDiscoveryEvalPrompt,
  evaluateActivitySkillDiscoveryOutput,
} from "../lib/chat/activity-skill-discovery-eval";

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return (
    process.argv
      .find((value) => value.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = argument("model") ?? "qwen3.5:4b";
const THRESHOLD = Number(argument("threshold") ?? "1");

async function generate(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: "Return only the final schema-valid JSON object now.",
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `ollama /api/chat -> ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

const outputDir = mkdtempSync(
  join(tmpdir(), "screenpipe-activity-skill-discovery-eval-"),
);
chmodSync(outputDir, 0o700);
let passed = 0;

for (const testCase of ACTIVITY_SKILL_DISCOVERY_EVAL_CASES) {
  let output = "";
  let failures: string[];
  try {
    output = await generate(buildActivitySkillDiscoveryEvalPrompt(testCase));
    failures = evaluateActivitySkillDiscoveryOutput(output, testCase);
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)];
  }
  if (failures.length === 0) passed += 1;
  writeFileSync(
    join(outputDir, `${testCase.id}.json`),
    JSON.stringify(
      {
        id: testCase.id,
        passed: failures.length === 0,
        failures,
        output,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `${failures.length === 0 ? "pass" : "FAIL"} ${testCase.id}${failures.length ? `: ${failures.join("; ")}` : ""}`,
  );
}

const rate = passed / ACTIVITY_SKILL_DISCOVERY_EVAL_CASES.length;
console.log(
  `${passed}/${ACTIVITY_SKILL_DISCOVERY_EVAL_CASES.length} passed (${(rate * 100).toFixed(0)}%); details: ${outputDir}`,
);
if (rate < THRESHOLD) process.exit(1);
