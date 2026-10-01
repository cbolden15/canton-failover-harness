import { Config, EndpointId, Fault, alternate, faultKind, operationDigest, validateSnapshot } from './model.js';
import { Journal } from './journal.js';
import { acceptance } from './acceptance.js';
import { Ledger } from './ledger.js';

export type Ledgers = Record<EndpointId, Ledger>;
export class Runner {
  private checked = new Set<EndpointId>();
  private deadline = Infinity;
  private stopped = false;
  private wake?: () => void;
  constructor(readonly config: Config, readonly journal: Journal, readonly ledgers: Ledgers) {}
  stop(): void { this.stopped = true; this.wake?.(); for (const l of Object.values(this.ledgers)) l.setDeadline(Date.now()); }
  private assertRunning(): void {
    if (this.stopped) throw new Fault('availability', 'Run interrupted; resume with the same journal');
  }
  private limit(until: number): void {
    this.assertRunning();
    for (const l of Object.values(this.ledgers)) l.setDeadline(until);
  }
  private async ready(id: EndpointId): Promise<void> {
    if (!this.checked.has(id)) { await this.ledgers[id].preflight(); this.checked.add(id); }
  }
  private async read(id: EndpointId) {
    await this.ready(id);
    const runId = this.journal.get<string>('runId')!;
    const view = validateSnapshot(await this.ledgers[id].snapshot(runId), runId, this.config.party, this.journal.get<string>('rootId'), this.config.count);
    if (view) {
      for (let i = 0; i < view.receipts.length; i++) {
        const r = view.receipts[i];
        const op = this.journal.operation(r.sequence);
        if (!op) throw new Fault('integrity', 'Ledger contains an operation absent from this journal');
        const successor = view.receipts[i + 1]?.inputStateId ?? view.state.contractId;
        this.journal.commit(r, successor, id);
      }
    }
    return view;
  }
  private async pause(until: number, duration = this.config.pollMs): Promise<void> {
    this.assertRunning();
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.max(0, Math.min(duration, until - Date.now())));
      this.wake = () => { clearTimeout(timer); resolve(); };
    });
    this.wake = undefined;
    this.assertRunning();
  }
  private recoverable(e: unknown): boolean { return ['availability', 'conflict', 'throttled'].includes(faultKind(e)); }

  /** Root creation has no consuming input guard, so an ambiguous create is never replayed. */
  async bootstrap(): Promise<void> {
    this.journal.assertConfig(this.config);
    if (!this.config.topologyConfirmed) throw new Fault('configuration', 'Confirm multi-hosting and independent participant submission before writes');
    if (this.journal.get('rootId')) return;
    const until = Date.now() + this.config.operationTimeoutMs;
    this.limit(until);
    const origin = this.journal.get<EndpointId>('bootstrapEndpoint') ?? this.config.primary;
    const runId = this.journal.get<string>('runId')!;
    if (this.journal.get('bootstrap') === 'planned') {
      // Require two healthy, configured participants before first creation.
      for (const id of ['A', 'B'] as const) {
        await this.ready(id);
        if (await this.read(id)) throw new Fault('integrity', 'Run ID already exists; refusing another root');
      }
      let attempt: string | undefined;
      try {
        await this.ledgers[origin].create(runId, () => {
          this.assertRunning();
          this.journal.set('bootstrapEndpoint', origin);
          this.journal.set('bootstrap', 'unknown');
          return attempt = this.journal.attempt(0, origin);
        });
        if (attempt) this.journal.attemptResult(attempt, 'acknowledged');
      } catch (e) {
        if (attempt) this.journal.attemptResult(attempt, faultKind(e));
        if (!this.recoverable(e)) throw e;
      }
    }
    while (Date.now() < until) {
      try {
        const view = await this.read(origin);
        if (view) {
          if (view.receipts.length || view.state.nextSequence !== 1) throw new Fault('integrity', 'Unexpected activity during bootstrap');
          const other = await this.read(alternate(origin));
          if (other && other.state.contractId === view.state.contractId) {
            this.journal.transaction(() => {
              this.journal.set('rootId', view.state.contractId); this.journal.set('bootstrap', 'confirmed');
              this.journal.event('root_confirmed', { contractId: view.state.contractId });
            });
            return;
          }
          if (other) throw new Fault('integrity', 'Participants disagree about root identity');
        }
      } catch (e) { if (!this.recoverable(e)) throw e; }
      await this.pause(until);
    }
    throw new Fault('availability', 'Root outcome unresolved. Resume to reconcile; no second root will be submitted');
  }

  async run(primary?: EndpointId): Promise<void> {
    this.journal.assertConfig(this.config);
    this.journal.set('result', 'INCONCLUSIVE');
    this.journal.delete('completedAt');
    await this.bootstrap();
    this.deadline = Date.now() + this.config.runTimeoutMs;
    let active = primary ?? this.journal.get<EndpointId>('active') ?? this.config.primary;
    this.journal.set('active', active);
    let failures = 0;
    const endpointError = (e: unknown, endpoint: EndpointId, sequence: number, attempt?: string): boolean => {
      const kind = faultKind(e);
      if (attempt) this.journal.attemptResult(attempt, kind);
      this.journal.event('endpoint_error', { endpoint, sequence, kind });
      if (!this.recoverable(e)) throw e;
      if (endpoint === active && kind === 'availability' && ++failures >= this.config.failureThreshold) {
        const previous = active; active = alternate(active); failures = 0;
        this.journal.set('active', active); this.journal.event('failover', { from: previous, to: active, sequence });
        return true;
      }
      return false;
    };
    try {
      for (let sequence = 1; sequence <= this.config.count; sequence++) {
        if (this.journal.operation(sequence)?.status === 'committed') continue;
        const until = Math.min(this.deadline, Date.now() + this.config.operationTimeoutMs);
        this.limit(until);
        let lastAttempt = this.journal.operation(sequence)?.status === 'unknown' ? Date.now() : -Infinity;
        const receiptStalledSince = Date.now();
        const probeInterval = Math.max(this.config.pollMs, this.config.retryAfterMs);
        let lastProbe = -Infinity;
        while (Date.now() < until) {
          let view: Awaited<ReturnType<Runner['read']>>;
          try { view = await this.read(active); }
          catch (e) {
            if (endpointError(e, active, sequence)) { await this.pause(until); continue; }
          }
          if (this.journal.operation(sequence)?.status === 'committed') { failures = 0; break; }
          const expectedInput = sequence === 1 ? this.journal.get<string>('rootId')! : this.journal.operation(sequence - 1)?.successorId;
          // Acknowledgements, conflicts, and stale reads do not establish receipt progress.
          if (Date.now() < until && Date.now() - receiptStalledSince >= probeInterval && Date.now() - lastProbe >= probeInterval) {
            const other = alternate(active);
            lastProbe = Date.now();
            try {
              const otherView = await this.read(other);
              const committed = this.journal.operation(sequence)?.status === 'committed';
              const activeAtInput = view?.state.nextSequence === sequence && view.state.contractId === expectedInput;
              const otherAtInput = otherView?.state.nextSequence === sequence && otherView.state.contractId === expectedInput;
              if (committed || (!activeAtInput && otherAtInput)) {
                const previous = active; active = other; failures = 0; view = otherView;
                this.journal.set('active', active);
                this.journal.event('failover', { from: previous, to: active, sequence, reason: 'receipt_stall' });
              }
            } catch (e) { endpointError(e, other, sequence); }
            if (this.journal.operation(sequence)?.status === 'committed') { failures = 0; break; }
          }
          let attempt: string | undefined;
          try {
            // A lagging or empty read cannot authorize a new operation or prove failure.
            if (view && view.state.nextSequence === sequence && view.state.contractId === expectedInput) {
              let op = this.journal.operation(sequence);
              if (!op) { this.journal.plan({ sequence, inputStateId: expectedInput!, payloadDigest: operationDigest(this.journal.get<string>('runId')!, sequence), status: 'planned' }); op = this.journal.operation(sequence)!; }
              if (Date.now() < until && Date.now() - lastAttempt >= this.config.retryAfterMs) {
                await this.ledgers[active].advance(this.journal.get<string>('runId')!, op, () => {
                  this.assertRunning();
                  lastAttempt = Date.now(); return attempt = this.journal.attempt(sequence, active);
                });
                if (attempt) this.journal.attemptResult(attempt, 'acknowledged');
                failures = 0;
              }
            }
          } catch (e) { endpointError(e, active, sequence, attempt); }
          await this.pause(until);
        }
        if (this.journal.operation(sequence)?.status !== 'committed') throw new Fault('availability', `Operation ${sequence} remains unresolved; resume with the same journal`);
        this.journal.event('progress', { completed: sequence, total: this.config.count });
        if (sequence < this.config.count) await this.pause(this.deadline, this.config.intervalMs);
      }
      await this.converge();
    } catch (e) {
      this.journal.set('result', ['integrity', 'acceptance'].includes(faultKind(e)) ? 'FAIL' : 'INCONCLUSIVE');
      this.journal.event('stopped', { kind: faultKind(e) }); throw e;
    }
  }

  private async converge(): Promise<void> {
    const until = Math.min(this.deadline, Date.now() + this.config.convergenceTimeoutMs);
    this.limit(until);
    while (Date.now() < until) {
      const evidence = acceptance(this.journal);
      if (evidence.status === 'failed') throw new Fault('acceptance', evidence.reason);
      try {
        const a = await this.read('A'); const b = await this.read('B');
        if (a && b && a.receipts.length === this.config.count && b.receipts.length === this.config.count &&
          a.state.contractId === b.state.contractId && a.receipts.every((r, i) => r.contractId === b.receipts[i].contractId)) {
          let accepted = false;
          this.journal.transaction(() => {
            const evidence = acceptance(this.journal);
            if (evidence.status === 'failed') throw new Fault('acceptance', evidence.reason);
            if (evidence.status === 'pending') return;
            this.journal.set('result', this.config.mode === 'simulation' ? 'SIMULATION_PASS' : 'PASS');
            this.journal.set('completedAt', new Date().toISOString()); this.journal.event('converged', { count: this.config.count });
            accepted = true;
          });
          if (accepted) return;
        }
      } catch (e) { if (!this.recoverable(e)) throw e; }
      await this.pause(until);
    }
    if (acceptance(this.journal).status === 'pending') throw new Fault('availability', 'Workload finished but the configured fault window is missing or open; resume to verify');
    throw new Fault('availability', 'Workload finished but both participants have not converged; resume to verify');
  }
}
