import { NextResponse } from "next/server";
import { z } from "zod";
import OpenAI from "openai";
import { redactPII, assertNoPIILeakage } from "@/lib/redact";

export const runtime = "nodejs";

const ReqSchema = z.object({
  resumeText: z.string().min(50),
  jobText: z.string().min(50),
  // Required (Privacy option A): allows deterministic redaction of the exact name.
  displayName: z.string().min(2),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = ReqSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Server-side redaction as a second layer (even if client already redacted).
  const redactedResume = redactPII(parsed.data.resumeText, { displayName: parsed.data.displayName });
  const redactedJob = redactPII(parsed.data.jobText, { displayName: parsed.data.displayName });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Server not configured: missing OPENAI_API_KEY. Redaction succeeded, but no LLM call was made.",
        redacted: {
          resumeText: redactedResume.text,
          jobText: redactedJob.text,
        },
      },
      { status: 500 },
    );
  }

  const client = new OpenAI({ apiKey });

  const system =
    "You are a strict career assistant for DACH (German). IMPORTANT PRIVACY RULES: Never output personal identifiers (real names, emails, phone numbers, street addresses, postal codes, exact DOB). Use placeholders like [NAME_1], [EMAIL_1], [PHONE_1], [ADDRESS_1], [POSTAL_CODE_1], [DOB_1]. Ground everything in the provided inputs; do not invent facts. If info is missing, ask questions in the 'questions' array. Output must be valid JSON only.";

  const user = `You will receive a job ad and a resume for a DACH Product Manager candidate.

Job ad (redacted):\n${redactedJob.text}\n\nResume (redacted):\n${redactedResume.text}\n
First, extract structure.
- Identify target role, level (junior/mid/senior), product domain, and top requirements.
- Identify evidence in the resume that matches requirements.
- Identify gaps where the resume lacks evidence.

Then generate improvements WITHOUT inventing facts.
Rules:
- Do not fabricate metrics, employers, products, dates, or achievements.
- If a bullet needs a metric but none exists, write the bullet WITHOUT numbers and add a note in "questions".
- Keep bullets short (1-2 lines), action + scope + outcome.
- Use neutral German (DACH). Avoid hype.
- Never output personal identifiers; use placeholders.

Return STRICT JSON with keys:
{
  "target_role": string,
  "level": "junior"|"mid"|"senior"|"unknown",
  "requirements": string[],
  "evidence": string[],
  "gaps": string[],
  "bullets": string[],
  "summary": string,
  "keywords": string[],
  "questions": string[]
}

IMPORTANT: The user expects a send-ready CV snippet. So:
- Keep "questions" very short (max 3) and only when absolutely necessary.
- Ensure "summary" and "bullets" are usable as-is.

Now do the task.`;

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content ?? "{}";

  // Output sanitation: redact again, plus quick leakage checks.
  const redactedOut = redactPII(content, { displayName: parsed.data.displayName }).text;
  const leaks = assertNoPIILeakage(redactedOut);

  return NextResponse.json({
    resultJson: redactedOut,
    leakage: leaks,
    usage: completion.usage,
  });
}
