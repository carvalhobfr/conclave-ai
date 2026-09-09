import { useEffect, useState } from "react";
import type { ValidationReport } from "../../src/domain/validation.js";
import type { FindingFeedback } from "../../src/storage/finding-feedback.js";
import { api } from "./api.js";

export function FeedbackPanel({ projectId, report }: { readonly projectId: string; readonly report: ValidationReport }) {
  const [records, setRecords] = useState<readonly FindingFeedback[]>([]);
  const [fingerprint, setFingerprint] = useState(report.findings[0]?.fingerprint ?? "");
  const [classification, setClassification] = useState<FindingFeedback["classification"]>("confirmed");
  const [note, setNote] = useState(""); const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => { let active = true; void api.feedback(projectId).then((items) => { if (active) setRecords(items); }).catch(() => { if (active) setMessage("Could not load feedback"); }); return () => { active = false; }; }, [projectId]);
  const save = async () => {
    setSaving(true);
    try { const result = await api.saveFeedback(projectId, report.lineage.reviewId, { fingerprint, classification, note }); setRecords((items) => [...items, result]); setNote(""); setMessage("Feedback saved locally. The review verdict is unchanged."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save feedback"); }
    finally { setSaving(false); }
  };
  return <section className="decision-card" aria-label="Finding feedback"><h3>Finding feedback</h3><p>Record what review established. Feedback stays on this machine and does not override evidence or verdicts.</p>
    <label>Finding<select value={fingerprint} onChange={(event) => setFingerprint(event.target.value)}>{report.findings.map((item) => <option key={item.fingerprint} value={item.fingerprint}>{item.title}</option>)}</select></label>
    <label>Assessment<select value={classification} onChange={(event) => setClassification(event.target.value as FindingFeedback["classification"])}><option value="confirmed">Confirmed problem</option><option value="false-positive">False positive</option><option value="accepted-risk">Accepted risk</option></select></label>
    <label>Reason<textarea value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" disabled={saving || !fingerprint || !note.trim()} onClick={() => void save()}>Save feedback</button>
    {message && <p role="status">{message}</p>}
    <ul>{records.filter((item) => item.reviewId === report.lineage.reviewId).map((item) => <li key={item.id}>{item.classification}: {item.note}</li>)}</ul>
  </section>;
}
