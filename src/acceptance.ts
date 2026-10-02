import { Journal } from './journal.js';
import { Scenario, alternate } from './model.js';

/** Operator-attested or client-proxy outage window and validated receipt evidence. */
export function acceptance(journal: Journal) {
  const scenario = journal.get<Scenario>('scenario') ?? { type: 'baseline' };
  const events = journal.events();
  const base = { qualifyingSequences: [] as number[], recoveryMs: null as number | null };
  if (scenario.type === 'baseline') return { ...base, status: 'eligible' as const, reason: 'Baseline workload; no outage acceptance requested', window: null };
  const markers = events.filter(e => e.kind === 'fault_start' || e.kind === 'fault_end');
  const [start, end] = markers;
  if (!start) return { ...base, status: 'pending' as const, reason: 'A closed fault window is required', window: null };
  const startMs = Date.parse(start.at), endMs = end ? Date.parse(end.at) : Infinity;
  if (markers.length > 2 || start.kind !== 'fault_start' ||
      start.data.endpoint !== scenario.faultedEndpoint || !Number.isFinite(startMs) ||
      (end && (end.kind !== 'fault_end' || start.id >= end.id || end.data.endpoint !== scenario.faultedEndpoint ||
        end.data.source !== start.data.source ||
        !Number.isFinite(endMs) || endMs < startMs)))
    return { ...base, status: 'pending' as const, reason: 'Fault markers do not form one ordered, matching window', window: null };
  const window = { endpoint: scenario.faultedEndpoint, startEventId: start.id, endEventId: end?.id ?? null, startedAt: start.at, endedAt: end?.at ?? null };
  const inside = (e: typeof start) => e.id > start.id && e.id < (end?.id ?? Infinity) && Date.parse(e.at) >= startMs && Date.parse(e.at) <= endMs;
  const unavailable = events.find(e => inside(e) && e.kind === 'endpoint_error' && e.data.endpoint === scenario.faultedEndpoint && e.data.kind === 'availability');
  const survivor = alternate(scenario.faultedEndpoint);
  const attemptsBySequence = new Map<unknown, typeof events>();
  for (const e of events.filter(e => e.kind === 'dispatching')) {
    const attempts = attemptsBySequence.get(e.data.sequence) ?? [];
    attempts.push(e); attemptsBySequence.set(e.data.sequence, attempts);
  }
  const qualifying = events.filter(e => {
    if (!unavailable || e.kind !== 'operation_committed' || e.data.endpoint !== survivor || !inside(e)) return false;
    const dispatches = attemptsBySequence.get(e.data.sequence) ?? [];
    return dispatches.length > 0 && dispatches.every(d => inside(d) && d.id > unavailable.id && d.id < e.id &&
      d.data.endpoint === survivor && Date.parse(d.at) >= Date.parse(unavailable.at) && Date.parse(d.at) <= Date.parse(e.at));
  });
  const qualifyingSequences = qualifying.map(e => e.data.sequence as number);
  const recoveryMs = qualifying.length ? Date.parse(qualifying[0].at) - startMs : null;
  if (!end) return { status: 'pending' as const, reason: recoveryMs !== null && recoveryMs > scenario.recoveryTimeoutMs
    ? 'Recovery bound exceeded; closing this fault window will fail acceptance'
    : qualifyingSequences.length >= scenario.minSurvivorOperations
    ? 'Survivor requirement reached; record fault-end before restoring the participant'
    : 'Fault window open; waiting for fresh survivor confirmations', qualifyingSequences, recoveryMs, window };
  if (qualifyingSequences.length < scenario.minSurvivorOperations)
    return { status: 'failed' as const, reason: 'Insufficient fresh survivor operations confirmed inside the fault window', qualifyingSequences, recoveryMs, window };
  if (recoveryMs === null || recoveryMs > scenario.recoveryTimeoutMs)
    return { status: 'failed' as const, reason: 'First qualifying client confirmation exceeded recoveryTimeoutMs', qualifyingSequences, recoveryMs, window };
  return { status: 'eligible' as const, reason: 'Fresh survivor progress meets the configured outage acceptance bounds', qualifyingSequences, recoveryMs, window };
}
