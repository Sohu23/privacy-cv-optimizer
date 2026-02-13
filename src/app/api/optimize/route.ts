import { NextResponse } from "next/server";
import { z } from "zod";
import OpenAI from "openai";
import { redactPII, assertNoPIILeakage } from "@/lib/redact";

export const runtime = "nodejs";

const ReqSchema = z.object({
  resumeText: z.string().min(50),
  jobText: z.string().min(50),
  // Optional, helps us deterministically redact the exact name.
  displayName: z.string().optional().nullable(),
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
  const redactedResume = redactPII(parsed.data.resumeText, { displayName: parsed.data.displayName ?? null });
  const redactedJob = redactPII(parsed.data.jobText, { displayName: parsed.data.displayName ?? null });

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
    "You are a career assistant. IMPORTANT PRIVACY RULES: Never output personal identifiers (real names, emails, phone numbers, street addresses, postal codes, exact DOB). Use placeholders like [NAME_1], [EMAIL_1], [PHONE_1], [ADDRESS_1], [POSTAL_CODE_1], [DOB_1]. Do not invent facts. Only use the provided inputs.";

  const user = `Job ad (redacted):\n${redactedJob.text}\n\nResume (redacted):\n${redactedResume.text}\n\nTask:\n1) Suggest 12 improved resume bullet points tailored to the job (ATS-friendly).\n2) Draft a concise professional summary (3-5 lines).\n3) List keywords/skills to add.\nReturn JSON with keys: bullets (string[]), summary (string), keywords (string[]).`;

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
  const redactedOut = redactPII(content, { displayName: parsed.data.displayName ?? null }).text;
  const leaks = assertNoPIILeakage(redactedOut);

  return NextResponse.json({
    resultJson: redactedOut,
    leakage: leaks,
    usage: completion.usage,
  });
}
