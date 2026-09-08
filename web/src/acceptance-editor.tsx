import { useEffect, useState } from "react";
import type { AcceptanceCriterion, ValidationContract } from "../../src/domain/validation.js";
import { api } from "./api.js";

export function AcceptanceEditor({ projectId, objective, onLoad, onChange }: { readonly projectId: string; readonly objective: string; readonly onLoad: (objective: string) => void; readonly onChange: (contract: string) => void }) {
  const [contract, setContract] = useState<ValidationContract>({ objective: "", claims: [], allowedPathPrefixes: [], criteria: [] });
  const [revision, setRevision] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setReady(false);
    void api.acceptance(projectId).then((saved) => {
      if (!active) return;
      const next = saved?.contract ?? { objective: "", claims: [], allowedPathPrefixes: [], criteria: [] };
      setContract(next); setRevision(saved?.revision ?? null); setReady(true);
      onChange(JSON.stringify(next));
      if (saved !== null && saved.contract.objective) onLoad(saved.contract.objective);
    }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "Could not load criteria"); });
    return () => { active = false; };
  }, [projectId, onChange, onLoad]);
  const update = (criteria: readonly AcceptanceCriterion[]) => {
    const next = { ...contract, objective, criteria };
    setContract(next); onChange(JSON.stringify(next)); setMessage("Unsaved changes");
  };
  const edit = (id: string, values: Partial<AcceptanceCriterion>) => update((contract.criteria ?? []).map((item) => item.id === id ? { ...item, ...values } : item));
  const save = async () => {
    setSaving(true);
    try { const saved = await api.saveAcceptance(projectId, { ...contract, objective }, revision); setRevision(saved.revision); setMessage("Criteria saved for future reviews."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save criteria"); }
    finally { setSaving(false); }
  };
  return <section className="acceptance-editor" aria-label="Acceptance criteria"><h2>Acceptance criteria</h2><p>Define the expected result and how to check it. Confirm each criterion before treating its evidence as support.</p>
    <fieldset disabled={!ready || saving}>
      {(contract.criteria ?? []).map((item) => <article className="decision-card" key={item.id}>
        <small>{item.id}</small>
        <label>Expected result<input aria-label={`Expected result ${item.id}`} value={item.statement} onChange={(event) => edit(item.id, { statement: event.target.value, confirmed: false })} /></label>
        <label>Verification plan<textarea value={item.verificationPlan} onChange={(event) => edit(item.id, { verificationPlan: event.target.value, confirmed: false })} /></label>
        <label>Evidence kind<select value={item.kind} onChange={(event) => edit(item.id, { kind: event.target.value as AcceptanceCriterion["kind"], confirmed: false })}><option value="test">Test execution</option><option value="runtime">Runtime observation</option><option value="human">Human decision</option><option value="structural">Structural claims only</option></select></label>
        <label>Implementation paths (comma separated)<input value={item.implementationPaths.join(", ")} onChange={(event) => edit(item.id, { implementationPaths: event.target.value.split(",").map((value) => value.trim()).filter(Boolean), confirmed: false })} /></label>
        {item.kind === "structural" && <label>Linked claim IDs (from advanced contract)<input value={item.claimIds.join(", ")} onChange={(event) => edit(item.id, { claimIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean), confirmed: false })} /></label>}
        <label><input type="checkbox" checked={item.confirmed} onChange={(event) => edit(item.id, { confirmed: event.target.checked })} />I confirm this criterion and verification plan</label>
        <button type="button" onClick={() => update((contract.criteria ?? []).filter((entry) => entry.id !== item.id))}>Remove criterion</button>
      </article>)}
      <button type="button" onClick={() => update([...(contract.criteria ?? []), { id: crypto.randomUUID(), statement: "", verificationPlan: "", kind: "test", confirmed: false, claimIds: [], implementationPaths: [] }])}>Add criterion</button>
      <button type="button" onClick={() => void save()}>Save criteria</button>
    </fieldset>{message && <p role="status">{message}</p>}
  </section>;
}
