# Architecture overview

Open `architecture.html` in a browser for the interactive diagram. It is self-contained; no server or Archify installation is needed to view it. This is a schematic of a live test environment, not proof that a particular deployment has been configured correctly.

![Canton failover harness architecture](architecture.visual-check.2048x1320.light.png)

## Read the diagram

The CLI runs on a client machine separate from the participants. Its signer uses the external party's private key locally. The OAuth credentials authorize Ledger API access on each participant; they are separate from the party signing key. The identity-provider branch applies to OAuth configurations. Static-token configurations use an environment-supplied token instead.

Participant A and participant B host the same external party identity on a shared synchronizer. The operator must verify confirming permissions and participant confirmation threshold one for this single-host-outage exercise. These are deployment prerequisites, not topology changes made by the harness. Upload and vet the same receipt DAR on both participants through the operator workflow.

The Ledger API connections cover preparation, signed execution, and complete receipt/state reads. Responses are not drawn separately. Both paths are available, but the workload submits through one active participant at a time. It switches after configured availability failures or qualifying alternate evidence when receipt progress stalls.

The local SQLite journal records intent before submission and an unknown attempt before execute. On uncertainty or restart, the CLI reconciles receipts and preserves the operation identity and input contract. The Daml `Advance` choice consumes that input and creates a receipt plus the next state atomically. An ambiguous initial root creation is only reconciled, never automatically replayed.

The operator introduces and restores infrastructure faults outside this tool and records outage markers. Failover acceptance requires fresh survivor operations inside the marked window, an observed outage, the configured recovery bound, and final agreement from both participants. JSON/CSV reports are exported from the journal. Simulation reports remain explicitly labelled simulation.

## Diagram source and verification

In the source checkout, `architecture.json` is the editable Archify source. Its eight source references are pinned to the repository revision recorded in `architecture.receipt.json`. Generated HTML passed all nine showcase artifact checks with zero errors or warnings. Automated browser checks passed at 1440×900, 1600×1000, 1920×1080, and 2048×1320. Light and dark screenshots were also visually reviewed.

The visual-check files preserve the browser evidence and provide a static GitHub preview. To regenerate, use the Archify skill's validate, deliver, and visual-check commands with this checkout as `--repo-root`; update the pinned revision only after verifying the diagram against that source revision.
