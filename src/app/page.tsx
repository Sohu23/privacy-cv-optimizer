"use client";

import { useMemo, useState } from "react";
import { redactPII } from "@/lib/redact";

// pdfjs-dist in Next App Router: use dynamic import on client.
async function extractTextFromPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // @ts-expect-error - worker entry path varies by bundler
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfjs as any).GlobalWorkerOptions.workerSrc = workerSrc;

  const data = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data });
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
  const [jobText, setJobText] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");

  const redactedPreview = useMemo(() => {
    if (!resumeText) return null;
    return redactPII(resumeText, { displayName: displayName || null });
  }, [resumeText, displayName]);

  async function onPickPdf(file: File | null) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const extracted = await extractTextFromPdf(file);
      setResumeText(extracted);
    } catch {
      setError("PDF konnte nicht gelesen werden. (Hinweis: Scan-PDFs ohne Text funktionieren oft nicht.)");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    setError("");
    setResult("");
    setBusy(true);
    try {
      // Client-side redaction first layer (server redacts again).
      const redJob = redactPII(jobText, { displayName: displayName || null }).text;
      const redResume = redactPII(resumeText, { displayName: displayName || null }).text;

      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobText: redJob,
          resumeText: redResume,
          displayName: displayName || null,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "Fehler");
        if (json?.redacted) {
          setResult(JSON.stringify(json.redacted, null, 2));
        }
        return;
      }

      setResult(json.resultJson || "");
    } catch {
      setError("Netzwerkfehler");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy-first CV Optimizer (MVP)</h1>
        <p className="mt-2 text-sm text-neutral-600">
          PDF wird <span className="font-medium">im Browser</span> zu Text extrahiert. Vor dem LLM werden
          persönliche Daten (E-Mail/Telefon/Adresse/PLZ/Geburtsdatum & Name) maskiert.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border p-4">
          <h2 className="text-lg font-medium">1) Jobanzeige</h2>
          <textarea
            className="mt-2 h-56 w-full rounded-md border p-2 text-sm"
            placeholder="Jobanzeige hier einfügen…"
            value={jobText}
            onChange={(e) => setJobText(e.target.value)}
          />
        </div>

        <div className="rounded-xl border p-4">
          <h2 className="text-lg font-medium">2) Lebenslauf</h2>
          <div className="mt-2 flex flex-col gap-2">
            <label className="text-sm">
              PDF Upload (local parsing):
              <input
                className="mt-1 block w-full text-sm"
                type="file"
                accept="application/pdf"
                onChange={(e) => onPickPdf(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
            </label>
            <textarea
              className="h-40 w-full rounded-md border p-2 text-sm"
              placeholder="…oder Text hier einfügen (falls PDF nicht geht)"
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-xl border p-4">
        <h2 className="text-lg font-medium">Privacy Controls</h2>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Dein Name (optional, hilft beim 100% Maskieren):
            <input
              className="mt-1 w-full rounded-md border p-2 text-sm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Max Mustermann"
            />
          </label>
          <div className="text-sm text-neutral-600">
            <p>
              Maskiert werden immer: <span className="font-medium">Name</span>, E-Mail, Telefon, Straße, PLZ,
              DOB. Stadt/Region bleiben (Empfehlung).
            </p>
            <p className="mt-1">
              Hinweis: Scan-PDFs (nur Bilder) können wir im MVP nicht zuverlässig auslesen.
            </p>
          </div>
        </div>
      </section>

      <div className="mt-4 flex items-center gap-3">
        <button
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          onClick={onSubmit}
          disabled={busy || jobText.trim().length < 50 || resumeText.trim().length < 50}
        >
          {busy ? "Arbeite…" : "Optimieren"}
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border p-4">
          <h3 className="text-sm font-medium">Redacted Preview (Resume)</h3>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs">
            {redactedPreview?.text || "(füge CV Text ein oder lade PDF hoch)"}
          </pre>
        </div>
        <div className="rounded-xl border p-4">
          <h3 className="text-sm font-medium">Result (JSON)</h3>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs">
            {result || "(noch nichts)"}
          </pre>
        </div>
      </section>

      <footer className="mt-10 text-xs text-neutral-500">
        <p>
          MVP Hinweis: Wir redigieren aggressiv, um Datenschutzrisiken zu minimieren. Für echte Nutzung:
          Datenschutzerklärung + Löschkonzept + DPA mit Provider (OpenAI) prüfen.
        </p>
      </footer>
    </main>
  );
}
