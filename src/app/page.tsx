"use client";

import { useMemo, useState } from "react";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { redactPII } from "@/lib/redact";

type OptimizeResponse = {
  target_role: string;
  level: "junior" | "mid" | "senior" | "unknown";
  requirements: string[];
  evidence: string[];
  gaps: string[];
  bullets: string[];
  summary: string;
  keywords: string[];
  questions: string[];
};

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadText(filename: string, text: string, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

async function downloadDocx(filename: string, r: OptimizeResponse) {
  // "Sendefertig" export: no questions / no gaps. Those are shown in-app as optional improvement hints.
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: "CV Optimizer – Ergebnis (sendefertig)",
            heading: HeadingLevel.TITLE,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Zielrolle: ", bold: true }),
              new TextRun(r.target_role || ""),
            ],
          }),
          new Paragraph({ text: "" }),

          new Paragraph({ text: "Kurzprofil", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: r.summary || "" }),
          new Paragraph({ text: "" }),

          new Paragraph({ text: "Optimierte Bulletpoints", heading: HeadingLevel.HEADING_1 }),
          ...r.bullets.map(
            (b) =>
              new Paragraph({
                text: b,
                bullet: { level: 0 },
              }),
          ),
          new Paragraph({ text: "" }),

          new Paragraph({ text: "Keywords (ATS)", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: (r.keywords || []).join(", ") })
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(filename, blob);
}

async function extractTextFromPdf(file: File): Promise<string> {
  // Use the legacy build for broader bundler compatibility on Vercel/Next.
  // This avoids relying on "?url" worker imports which can break depending on build tooling.
  type PdfTextContent = { items: Array<{ str?: string } | unknown> };
  type PdfPage = { getTextContent: () => Promise<PdfTextContent> };
  type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };

  const pdfjsMod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (args: { data: ArrayBuffer }) => { promise: Promise<PdfDoc> };
    GlobalWorkerOptions: { workerSrc: string };
  };

  // Point workerSrc to the bundled worker via import.meta.url.
  const workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  pdfjsMod.GlobalWorkerOptions.workerSrc = workerSrc;

  const data = await file.arrayBuffer();
  const loadingTask = pdfjsMod.getDocument({ data });
  const pdf = await loadingTask.promise;

  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => ("str" in it ? it.str : ""))
      .filter(Boolean);
    out += strings.join(" ") + "\n";
  }
  return out.trim();
}

export default function Home() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [displayName, setDisplayName] = useState("");
  const [jobText, setJobText] = useState("");
  const [resumeText, setResumeText] = useState("");

  const [showRedactionPreview, setShowRedactionPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const [resultRawJson, setResultRawJson] = useState<string>("");
  const [resultObj, setResultObj] = useState<OptimizeResponse | null>(null);

  const [score, setScore] = useState<
    | null
    | {
        score_before: number;
        score_after: number;
        reasons_improved: string[];
        gaps_before: string[];
        gaps_after: string[];
      }
  >(null);
  const [baselineBeforeScore, setBaselineBeforeScore] = useState<number | null>(null);
  const [baselineBeforeGaps, setBaselineBeforeGaps] = useState<string[] | null>(null);
  const [scoreStatus, setScoreStatus] = useState<"idle" | "loading" | "error">("idle");

  const [clarifications, setClarifications] = useState("");
  const [refineBusy, setRefineBusy] = useState(false);

  const redactedResumePreview = useMemo(() => {
    if (!resumeText.trim()) return null;
    if (displayName.trim().length < 2) return null;
    return redactPII(resumeText, { displayName });
  }, [resumeText, displayName]);

  const redactedJobPreview = useMemo(() => {
    if (!jobText.trim()) return null;
    if (displayName.trim().length < 2) return null;
    return redactPII(jobText, { displayName });
  }, [jobText, displayName]);

  async function onPickPdf(file: File | null) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const extracted = await extractTextFromPdf(file);
      setResumeText(extracted);
      setStep(3);
    } catch {
      setError(
        "PDF konnte nicht gelesen werden. Hinweis: Scan-PDFs (nur Bilder) funktionieren oft nicht.",
      );
    } finally {
      setBusy(false);
    }
  }

  function buildResumeAfter(parsed: OptimizeResponse) {
    return [
      parsed.summary,
      "",
      "Optimierte Bulletpoints:",
      ...(parsed.bullets || []),
      "",
      "Keywords:",
      (parsed.keywords || []).join(", "),
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function fetchScore(opts: {
    redJob: string;
    redBefore: string;
    parsed: OptimizeResponse;
    redClarifications?: string;
    lockBefore?: boolean;
  }) {
    setScoreStatus("loading");
    try {
      const resumeAfter = buildResumeAfter(opts.parsed);
      const scoreRes = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobText: opts.redJob,
          resumeBefore: opts.redBefore,
          resumeAfter,
          displayName,
          clarifications: opts.redClarifications,
        }),
      });

      if (!scoreRes.ok) {
        setScoreStatus("error");
        return;
      }

      const s = await scoreRes.json();

      const nextBeforeScore =
        opts.lockBefore && baselineBeforeScore !== null ? baselineBeforeScore : s.score_before;
      const nextBeforeGaps =
        opts.lockBefore && baselineBeforeGaps !== null ? baselineBeforeGaps : (s.gaps_before || []);

      // Persist baseline on first scoring (no clarifications).
      if (!opts.lockBefore && baselineBeforeScore === null) {
        setBaselineBeforeScore(s.score_before);
        setBaselineBeforeGaps(s.gaps_before || []);
      }

      setScore({
        score_before: nextBeforeScore,
        score_after: s.score_after,
        reasons_improved: s.reasons_improved || [],
        gaps_before: nextBeforeGaps,
        gaps_after: s.gaps_after || [],
      });
      setScoreStatus("idle");
    } catch {
      setScoreStatus("error");
    }
  }

  async function onSubmit() {
    setError("");
    setResultRawJson("");
    setResultObj(null);
    setScore(null);
    setScoreStatus("loading");
    setBusy(true);
    try {
      const redJob = redactPII(jobText, { displayName }).text;
      const redResume = redactPII(resumeText, { displayName }).text;

      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobText: redJob,
          resumeText: redResume,
          displayName,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "Fehler");
        return;
      }

      const raw = String(json.resultJson || "{}");
      setResultRawJson(raw);
      const parsed = JSON.parse(raw) as OptimizeResponse;
      setResultObj(parsed);
      setStep(4);

      // Initial score establishes the baseline (BEFORE) and AFTER for the first optimization.
      await fetchScore({ redJob, redBefore: redResume, parsed, lockBefore: false });
    } catch {
      setError("Netzwerk-/Parsingfehler");
    } finally {
      setBusy(false);
    }
  }

  const canGoStep2 = displayName.trim().length >= 2;
  const canGoStep3 = canGoStep2 && jobText.trim().length >= 80;
  const canOptimize = canGoStep3 && resumeText.trim().length >= 80;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-neutral-500">CV OPTIMIZER</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-neutral-900">
              Privacy-first Bewerbungs-Optimierung
            </h1>
            <p className="mt-2 text-sm text-neutral-600">
              Clean & corporate MVP. PDF wird lokal im Browser gelesen; personenbezogene Daten werden vor KI
              maskiert.
            </p>
          </div>
          <div className="hidden rounded-xl border bg-white px-4 py-3 text-xs text-neutral-600 md:block">
            <p className="font-medium text-neutral-800">Privacy by design</p>
            <ul className="mt-1 list-disc pl-4">
              <li>PDF verlässt deinen Browser nicht</li>
              <li>Name Pflicht → 100% maskiert</li>
              <li>Straße & PLZ werden maskiert</li>
            </ul>
          </div>
        </div>

        <div className="mt-5 rounded-xl border bg-neutral-50 p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={classNames(
                  "flex items-center gap-2 rounded-full border px-3 py-1",
                  step === n
                    ? "border-neutral-900 bg-white text-neutral-900"
                    : "border-neutral-200 bg-white text-neutral-500",
                )}
              >
                <span
                  className={classNames(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                    step === n ? "bg-neutral-900 text-white" : "bg-neutral-200 text-neutral-700",
                  )}
                >
                  {n}
                </span>
                <span className="font-medium">
                  {n === 1
                    ? "Name"
                    : n === 2
                      ? "Job"
                      : n === 3
                        ? "CV"
                        : "Ergebnis"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </header>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {/* STEP 1 */}
      {step === 1 ? (
        <section className="rounded-2xl border bg-white p-6">
          <h2 className="text-lg font-semibold text-neutral-900">Dein Name (Pflicht)</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Wir nutzen ihn ausschließlich, um ihn zuverlässig zu maskieren (→ <code>[NAME_1]</code>) bevor
            Text an das LLM geht.
          </p>

          <label className="mt-4 block text-sm font-medium text-neutral-800">
            Vollständiger Name
            <input
              className="mt-2 w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-neutral-900"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Max Mustermann"
              autoComplete="name"
            />
          </label>

          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-xs text-neutral-500">
              Maskiert werden: Name, E-Mail, Telefon, Straße, PLZ, DOB, URLs, IDs.
            </div>
            <button
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={!canGoStep2}
              onClick={() => setStep(2)}
            >
              Weiter
            </button>
          </div>
        </section>
      ) : null}

      {/* STEP 2 */}
      {step === 2 ? (
        <section className="rounded-2xl border bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">Jobanzeige</h2>
              <p className="mt-1 text-sm text-neutral-600">
                Füge den relevanten Teil der Anzeige ein (Aufgaben/Profil reichen). Optional kannst du später
                eine zweite Anzeige testen.
              </p>
            </div>
            <button
              className="text-sm font-medium text-neutral-700 underline"
              onClick={() => setStep(1)}
            >
              Zurück
            </button>
          </div>

          <textarea
            className="mt-4 h-64 w-full rounded-md border p-3 text-sm outline-none focus:border-neutral-900"
            placeholder="Jobanzeige hier einfügen…"
            value={jobText}
            onChange={(e) => setJobText(e.target.value)}
          />

          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-xs text-neutral-500">Tipp: je konkreter Anforderungen, desto besser.</div>
            <button
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={!canGoStep3}
              onClick={() => setStep(3)}
            >
              Weiter
            </button>
          </div>
        </section>
      ) : null}

      {/* STEP 3 */}
      {step === 3 ? (
        <section className="rounded-2xl border bg-white p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">Lebenslauf</h2>
              <p className="mt-1 text-sm text-neutral-600">
                PDF Upload (lokal im Browser) oder Text einfügen. Scan-PDFs ohne Text funktionieren meist
                nicht.
              </p>
            </div>
            <button
              className="text-sm font-medium text-neutral-700 underline"
              onClick={() => setStep(2)}
            >
              Zurück
            </button>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium text-neutral-900">PDF Upload</p>
              <input
                className="mt-3 block w-full text-sm"
                type="file"
                accept="application/pdf"
                onChange={(e) => onPickPdf(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
              <p className="mt-2 text-xs text-neutral-500">
                Hinweis: Die PDF-Datei wird nur in deinem Browser verarbeitet und nicht an den Server
                übertragen.
              </p>
            </div>

            <div className="rounded-xl border p-4">
              <p className="text-sm font-medium text-neutral-900">Oder Text einfügen</p>
              <textarea
                className="mt-3 h-40 w-full rounded-md border p-3 text-sm outline-none focus:border-neutral-900"
                placeholder="CV Text hier einfügen…"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={showRedactionPreview}
                onChange={(e) => setShowRedactionPreview(e.target.checked)}
              />
              Redaction Preview anzeigen
            </label>

            <button
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={busy || !canOptimize}
              onClick={onSubmit}
            >
              {busy ? "Arbeite…" : "Optimieren"}
            </button>
          </div>

          {showRedactionPreview ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border p-4">
                <p className="text-sm font-medium text-neutral-900">Jobanzeige (maskiert)</p>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs">
                  {redactedJobPreview?.text || "(noch nichts)"}
                </pre>
              </div>
              <div className="rounded-xl border p-4">
                <p className="text-sm font-medium text-neutral-900">CV (maskiert)</p>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs">
                  {redactedResumePreview?.text || "(noch nichts)"}
                </pre>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* STEP 4 */}
      {step === 4 && resultObj ? (
        <section className="rounded-2xl border bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">Ergebnis</h2>
              <p className="mt-1 text-sm text-neutral-600">
                Zielrolle: <span className="font-medium">{resultObj.target_role}</span> · Level:{" "}
                <span className="font-medium">{resultObj.level}</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="rounded-md border px-3 py-2 text-sm font-medium text-neutral-800"
                onClick={() => setStep(3)}
              >
                Neue Optimierung
              </button>
              <button
                className="rounded-md border px-3 py-2 text-sm font-medium text-neutral-800"
                onClick={async () => {
                  await downloadDocx("bewerbung-optimierung.docx", resultObj);
                }}
              >
                Word (.docx)
              </button>
              <button
                className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white"
                onClick={() => downloadText("result.json", resultRawJson)}
              >
                JSON
              </button>
            </div>
          </div>

          {scoreStatus !== "idle" || score ? (
            <div className="mt-4 rounded-xl border bg-neutral-50 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="text-sm font-semibold text-neutral-900">Match zur Jobanzeige (0–100)</p>
                {score ? (
                  <p className="text-sm text-neutral-700">
                    Vorher: <span className="font-semibold">{score.score_before}</span> · Nachher:{" "}
                    <span className="font-semibold">{score.score_after}</span> · Δ{" "}
                    <span className="font-semibold">
                      {score.score_after - score.score_before >= 0 ? "+" : ""}
                      {score.score_after - score.score_before}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-neutral-700">–</p>
                )}
              </div>

              {scoreStatus === "loading" ? (
                <p className="mt-2 text-sm text-neutral-600">Score wird neu berechnet…</p>
              ) : null}
              {scoreStatus === "error" ? (
                <p className="mt-2 text-sm text-red-700">
                  Score konnte nicht aktualisiert werden (temporärer Fehler). Bitte erneut optimieren oder
                  Antworten nochmal anwenden.
                </p>
              ) : null}

              {score ? (
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-neutral-700">Verbessert, weil</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-800">
                      {score.reasons_improved.slice(0, 5).map((r, idx) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-neutral-700">Offen / Risiken</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-800">
                      {score.gaps_after.slice(0, 5).map((r, idx) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Optional clarifications chat */}
          {resultObj.questions?.length ? (
            <div className="mt-4 rounded-xl border bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-neutral-900">Rückfragen (optional)</p>
                <p className="text-xs text-neutral-500">Temporär · max. 2000 Zeichen</p>
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-800">
                {resultObj.questions.slice(0, 3).map((q, idx) => (
                  <li key={idx}>{q}</li>
                ))}
              </ul>

              <label className="mt-3 block text-sm font-medium text-neutral-800">
                Deine Antworten
                <textarea
                  className="mt-2 h-28 w-full rounded-md border p-3 text-sm outline-none focus:border-neutral-900"
                  value={clarifications}
                  onChange={(e) => setClarifications(e.target.value.slice(0, 2000))}
                  placeholder="Kurze Antworten, stichpunktartig ist ok…"
                />
              </label>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-neutral-500">
                  Zeichen: {clarifications.length}/2000
                </p>
                <button
                  className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  disabled={refineBusy || clarifications.trim().length < 5}
                  onClick={async () => {
                    setRefineBusy(true);
                    setError("");
                    // Ensure user sees that the score will be recomputed (avoid displaying stale numbers).
                    setScore(null);
                    setScoreStatus("loading");
                    try {
                      const redJob = redactPII(jobText, { displayName }).text;
                      const redResume = redactPII(resumeText, { displayName }).text;
                      const redAnswers = redactPII(clarifications, { displayName }).text;

                      const refineRes = await fetch("/api/refine", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          jobText: redJob,
                          resumeText: redResume,
                          displayName,
                          questions: resultObj.questions.slice(0, 3),
                          answers: redAnswers,
                        }),
                      });

                      const rj = await refineRes.json();
                      if (!refineRes.ok) {
                        setError(rj?.error || "Fehler");
                        return;
                      }

                      const raw = String(rj.resultJson || "{}");
                      setResultRawJson(raw);
                      const parsed = JSON.parse(raw) as OptimizeResponse;
                      setResultObj(parsed);
                      // Re-score after clarifications, but lock the BEFORE score to the original baseline.
                      await fetchScore({
                        redJob,
                        redBefore: redResume,
                        parsed,
                        redClarifications: redAnswers,
                        lockBefore: true,
                      });
                    } catch {
                      setError("Netzwerk-/Parsingfehler");
                    } finally {
                      setRefineBusy(false);
                    }
                  }}
                >
                  {refineBusy ? "Wende an…" : "Antworten anwenden"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Kurzprofil</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-800">{resultObj.summary}</p>
              <div className="mt-3">
                <button
                  className="text-sm font-medium text-neutral-700 underline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(resultObj.summary);
                  }}
                >
                  Kopieren
                </button>
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Keywords</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {resultObj.keywords.map((k) => (
                  <span
                    key={k}
                    className="rounded-full border bg-white px-3 py-1 text-xs text-neutral-800"
                  >
                    {k}
                  </span>
                ))}
              </div>
              <div className="mt-3">
                <button
                  className="text-sm font-medium text-neutral-700 underline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(resultObj.keywords.join(", "));
                  }}
                >
                  Kopieren
                </button>
              </div>
            </div>

            <div className="rounded-xl border p-4 md:col-span-2">
              <h3 className="text-sm font-semibold text-neutral-900">Bulletpoints (CV)</h3>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-neutral-800">
                {resultObj.bullets.map((b, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {b}
                  </li>
                ))}
              </ol>
              <div className="mt-3">
                <button
                  className="text-sm font-medium text-neutral-700 underline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(resultObj.bullets.join("\n"));
                  }}
                >
                  Kopieren
                </button>
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Gaps</h3>
              <p className="mt-1 text-xs text-neutral-500">(aus dem Match-Scoring; konsistent mit Risiken)</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-800">
                {(score?.gaps_after || []).map((g, idx) => (
                  <li key={idx}>{g}</li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-neutral-900">Fragen (für bessere Qualität)</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-800">
                {resultObj.questions.map((q, idx) => (
                  <li key={idx}>{q}</li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border p-4 md:col-span-2">
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-neutral-900">
                  Technische Ansicht (raw JSON)
                </summary>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs">
                  {resultRawJson}
                </pre>
              </details>
            </div>
          </div>
        </section>
      ) : null}

      <footer className="mt-10 text-xs text-neutral-500">
        <p>
          Hinweis: MVP. Redaction ist aggressiv, um Datenschutzrisiken zu minimieren. Für Launch:
          Datenschutzerklärung/Impressum/Verarbeitungsverzeichnis/DPA prüfen.
        </p>
      </footer>
    </main>
  );
}
