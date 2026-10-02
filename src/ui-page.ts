export const uiPage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canton · Traffic failover</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101419;color:#eaf0f5}*{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:auto;padding:40px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}h1{font-size:32px;margin:8px 0 12px;letter-spacing:-1px}h2{font-size:16px;margin:0 0 18px}.muted,small{color:#9ba9b8}p{line-height:1.5}.tag{font-size:11px;letter-spacing:2px;color:#73d9c4}button{background:#73d9c4;color:#10201e;border:0;border-radius:8px;padding:13px 20px;font:600 14px system-ui;cursor:pointer}button:disabled{opacity:.5;cursor:default}.panel{border:1px solid #2b333e;background:#171d25;border-radius:12px;padding:24px;margin:24px 0}.flow{display:grid;grid-template-columns:1fr 64px 2fr;align-items:center;gap:16px}.client{border:1px solid #35404e;border-radius:10px;padding:28px 16px;text-align:center}.routes{display:grid;gap:16px}.route{border:1px solid #35404e;border-radius:10px;padding:20px;transition:background .2s,border-color .2s}.route.active{border-color:#73d9c4;background:#1a302e}.route.faulted{border-color:#e8aa77}.route strong{display:block;font-size:20px;margin-bottom:8px}.arrow{color:#73d9c4;font-size:32px;text-align:center}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.stats strong{display:block;font-size:28px;margin-top:8px}.strip{display:flex;gap:5px;flex-wrap:wrap;margin:18px 0}.op{min-width:28px;height:28px;border-radius:5px;border:1px solid #536170;font-size:11px;display:grid;place-items:center;color:#c2ccd8}.op.a{background:#73d9c4;color:#11231f;border-color:#73d9c4}.op.b{background:#91b7ff;color:#101f33;border-color:#91b7ff}.op.unknown{border-style:dashed;color:#e8aa77}.legend{font-size:12px;color:#9ba9b8}.log{list-style:none;padding:0;margin:0;max-height:260px;overflow:auto}.log li{padding:12px 0;border-bottom:1px solid #2b333e;font-size:14px}.log time{color:#9ba9b8;font-variant-numeric:tabular-nums;margin-right:16px}#connection{font-size:13px;color:#9ba9b8;margin-top:16px}#result{overflow-wrap:anywhere}button:focus-visible{outline:3px solid #91b7ff;outline-offset:4px}@media(max-width:600px){main{padding:24px 16px}header{align-items:flex-start;flex-direction:column}.panel{padding:18px}.flow{grid-template-columns:1fr 28px 2fr;gap:8px}.client{padding:20px 8px}.route{padding:14px}.stats{gap:8px}.stats strong{font-size:24px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main>
<header><div><span class="tag">CANTON / FAILOVER HARNESS</span><h1>Watch traffic find its way.</h1><p class="muted" id="description">Run a local simulation. Participant A goes offline; the harness continues through B.</p></div><button id="demo">Start simulation</button></header>
<p id="connection" role="status" aria-live="polite">Connecting to local viewer…</p>
<section class="panel"><h2 id="mode">Simulation · no Canton network calls</h2><div class="flow"><div class="client"><strong>Workload</strong><p class="muted">Signed operations</p></div><div class="arrow" aria-hidden="true">→</div><div class="routes"><div class="route" id="routeA"><strong>Participant A</strong><span id="statusA">Awaiting run</span></div><div class="route" id="routeB"><strong>Participant B</strong><span id="statusB">Awaiting run</span></div></div></div><p class="muted">Both participants host the same party. Highlighted route = selected submission endpoint.</p></section>
<section class="panel"><div class="stats"><div><small>Confirmed operations</small><strong id="count">0 / 0</strong></div><div><small>Endpoint switches</small><strong id="switches">0</strong></div><div><small>Outcome</small><strong id="result" style="font-size:16px">Awaiting run</strong></div></div><div class="strip" id="operations" aria-label="Operation confirmations"></div><div class="legend">Green: confirmed via A · Blue: confirmed via B · Dashed: outcome unknown · Outline: planned</div><p class="muted" style="font-size:12px">Colors show where receipts were observed, which can differ from the endpoint that executed an operation. Unknown outcomes remain unresolved until receipt reconciliation.</p></section>
<section class="panel"><h2>Traffic timeline</h2><ol class="log" id="events"><li class="muted">Start a simulation to see submissions, confirmations, and the endpoint switch.</li></ol></section>
<p class="muted" style="font-size:12px" id="run"></p><p class="muted" style="font-size:12px">Client-observed harness traffic, not network throughput or ledger finality latency. Live outage markers are operator-attested. No live fault controls are exposed here.</p>
</main><script>
const $ = id => document.getElementById(id);
let pending = false;
function render(value){
  const r=value.snapshot;
  $('demo').hidden=value.readOnly;
  $('description').textContent=value.readOnly?'Read-only journal view. Run the workload and introduce faults using your existing operator procedure.':'Run a local simulation. Participant A goes offline; the harness continues through B.';
  $('demo').disabled=value.running||pending;
  $('demo').textContent=value.running?'Simulation running…':r?'Run another simulation':'Start simulation';
  $('mode').textContent=r?r.mode==='simulation'?'SIMULATION · no Canton network calls':'LIVE HARNESS · read-only viewer':value.readOnly?'Journal viewer':'SIMULATION · no Canton network calls';
  if(!r)return;
  $('run').textContent='Run '+r.runId;
  $('count').textContent=r.committed+' / '+r.plannedTotal;
  $('switches').textContent=r.failovers;
  $('result').textContent=r.completedAt||r.stopped?r.result.replaceAll('_',' '):'Awaiting completion';
  const faults=new Set();
  for(const e of r.events){if(e.kind==='fault_start')faults.add(e.data.endpoint);if(e.kind==='fault_end')faults.delete(e.data.endpoint);}
  for(const id of ['A','B']){
    const active=r.activeEndpoint===id;
    $('route'+id).className='route'+(active?' active':'')+(faults.has(id)?' faulted':'');
    $('status'+id).textContent=(active?'Selected route':'Standby route')+(faults.has(id)?' · outage marked':'');
  }
  const observed=new Map(r.events.filter(e=>e.kind==='operation_committed').map(e=>[e.data.sequence,e.data.endpoint]));
  const strip=document.createDocumentFragment();
  for(const o of r.operations){const el=document.createElement('span');const endpoint=observed.get(o.sequence);el.className='op '+(o.status==='committed'?(endpoint==='A'?'a':endpoint==='B'?'b':''):o.status==='unknown'?'unknown':'');el.textContent=o.sequence;el.title='Operation '+o.sequence+': '+o.status+(endpoint?' (receipt via '+endpoint+')':'');strip.append(el);}
  $('operations').replaceChildren(strip);
  const attempts=new Map(r.attempts.map(a=>[a.id,a]));
  const fragment=document.createDocumentFragment();
  for(const e of r.events.slice().reverse()){
    const d=e.data;let message='';
    if(e.kind==='dispatching')message=(d.sequence===0?'Root creation':'Operation '+d.sequence)+' submitted through '+d.endpoint;
    if(e.kind==='operation_committed')message='Operation '+d.sequence+' confirmed'+(d.endpoint?' via '+d.endpoint:'');
    if(e.kind==='failover')message='Traffic switched '+d.from+' → '+d.to+' for operation '+d.sequence;
    if(e.kind==='fault_start')message='Outage marked on '+d.endpoint;
    if(e.kind==='fault_end')message='Outage ended on '+d.endpoint;
    if(e.kind==='converged')message='Both participants agree on the final receipt chain';
    if(e.kind==='endpoint_error')message='Participant '+d.endpoint+': '+d.kind+' observed';
    if(e.kind==='command_error'||e.kind==='stopped')message='Run stopped: '+d.kind+'; journal preserved';
    if(e.kind==='attempt_result'&&d.result!=='acknowledged'){const a=attempts.get(d.attemptId);message='Submission '+(a?'via '+a.endpoint+' ':'')+'returned '+d.result+'; receipts determine outcome';}
    if(!message)continue;
    const li=document.createElement('li');const time=document.createElement('time');time.textContent=new Date(e.at).toLocaleTimeString();li.append(time,document.createTextNode(message));fragment.append(li);
    if(fragment.childNodes.length>=60)break;
  }
  $('events').replaceChildren(fragment);
}
async function poll(){try{const response=await fetch('/api/traffic');if(!response.ok)throw Error();render(await response.json());$('connection').textContent='Connected · refreshed '+new Date().toLocaleTimeString();}catch{$('connection').textContent='Connection unavailable · displayed data may be stale. Retrying…';}finally{setTimeout(poll,400);}}
$('demo').addEventListener('click',async()=>{pending=true;$('demo').disabled=true;try{const response=await fetch('/api/demo',{method:'POST'});if(!response.ok)throw Error();}catch{$('connection').textContent='Could not start simulation. Check the local server.';}finally{pending=false;}});
poll();
</script></body></html>`;
