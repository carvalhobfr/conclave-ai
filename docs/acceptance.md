# Acceptance criteria

Open a local repository with `conclave open .`. Add expected results, verification plans and evidence kinds, then confirm each criterion and save. Editing the statement, plan or links clears confirmation. Contracts live in `.conclave/acceptance-contract.json`; concurrent saves require the original revision so another editor cannot silently overwrite changes. Source files are untouched.

`conclave criteria .` adds a criterion through prompts; `conclave criteria . --json` reads the saved contract. `conclave check .` automatically uses the saved objective and criteria. An explicit `--contract` overrides the saved contract. Existing structural claims can still be supplied in the advanced contract editor.

Review, attach receipts and recheck against a saved report. CLI users pass `--previous-report report.json --receipt receipts.json`; cockpit users select the previous review and attach a JSON receipt file. Each receipt includes `criterionDigests`, an object mapping stable criterion IDs to the digest emitted by the report. Changed criteria cannot reuse their earlier evidence. Changing or removing requirements marks the series as needing an explicit baseline decision.

Criteria show `not-verified`, `supported`, `contradicted` or `human-decision`. Structural support only considers linked claim IDs. Execution support requires the declared evidence kind, a matching criterion digest and current artifact binding. Matching failed execution takes precedence over matching success. Self-reported support never establishes independent provenance or test adequacy. A human criterion requires a separate human decision and cannot be completed by an automated report.

New reports use schema v4. V2 and v3 remain readable and comparable; consumers validating new output must adopt `schemas/validation-report.v4.schema.json`.
