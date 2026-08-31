'use strict';
// Validate the buyer-independent legs of the composite rule on the 48h cohort.
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const netQ = (t) => Number(t.q) - Number(t.f || 0) - Number(t.x || 0);
const buyOut = (Q,T,q) => T*q/(Q+q), sellOut = (Q,T,t) => Q*t/(T+t);
function solve(tr){const b=tr.filter(x=>x.buy).slice(0,2); if(b.length<2)return null;
  const q1=netQ(b[0]),t1=Number(b[0].t),q2=netQ(b[1]),t2=Number(b[1].t),dn=t1*q2-t2*q1;
  if(!(Math.abs(dn)>0))return null; const Q0=t2*q1*(q1+q2)/dn; if(!(Q0>0)||!isFinite(Q0))return null;
  const T0=t1*(Q0+q1)/q1; return (T0>0&&isFinite(T0))?{Q0,T0}:null;}
function cost(tr){const r=tr.filter(x=>x.buy&&Number(x.q)>0).map(x=>(Number(x.f||0)+Number(x.x||0))/Number(x.q)).sort((a,b)=>a-b);
  return r.length?r[Math.floor(r.length/2)]:0.03;}

const C=d.curves;
console.log(`48h cohort: ${C.length} ETH-quoted curves, ${C.filter(c=>c.graduated).length} graduated ` +
  `(${(C.filter(c=>c.graduated).length/C.length*100).toFixed(3)}%)\n`);

// creator prior launches (strictly earlier createdBlock)
const byC=new Map();
for(const c of C){ if(!byC.has(c.creator)) byC.set(c.creator,[]); byC.get(c.creator).push(c.createdBlock); }
for(const v of byC.values()) v.sort((a,b)=>a-b);
const prior=c=>byC.get(c.creator).filter(b=>b<c.createdBlock).length;
const buckets={};
for(const c of C){ const k=Math.min(prior(c),3); (buckets[k]=buckets[k]||{n:0,g:0}); buckets[k].n++; if(c.graduated)buckets[k].g++; }
console.log('CREATOR PRIOR LAUNCHES  (12h result: 0 prior = 1.536%, >=1 = 0.240%, 6.4x)');
for(const k of Object.keys(buckets).sort()){const b=buckets[k];
  console.log(`  ${k==='3'?'3+':k} prior: ${String(b.n).padStart(6)} curves, ${String(b.g).padStart(4)} graduated = ${(b.g/b.n*100).toFixed(3)}%`);}
const z=buckets[0], nz=Object.entries(buckets).filter(([k])=>k!=='0').reduce((a,[,b])=>({n:a.n+b.n,g:a.g+b.g}),{n:0,g:0});
console.log(`  → 0 prior ${(z.g/z.n*100).toFixed(3)}%  vs  >=1 prior ${(nz.g/nz.n*100).toFixed(3)}%   lift ${((z.g/z.n)/(nz.g/nz.n)).toFixed(1)}x`);

// f1 economics: enter at 1% funding, no selector
const AGG=0.01,GAS=0.00008,SIZE=0.1;
let g=[],dd=[];
for(const c of C){ const r=solve(c.trades); if(!r) continue; const thr=Number(c.gradThreshold); if(!(thr>0))continue;
  const CF=cost(c.trades); let Q=r.Q0,T=r.T0,f=0,held=0,spent=0,trig=false;
  for(const tr of c.trades){ const q=netQ(tr),t=Number(tr.t);
    if(!held&&trig){ const net=SIZE*1e18*(1-AGG)*(1-CF); const got=buyOut(Q,T,net); if(!(got>0))break;
      held=got;spent=SIZE+GAS;Q+=net;T-=got;f+=net; }
    if(tr.buy){Q+=q;T-=t;f+=q;}else{Q-=q;T+=t;f-=q;}
    if(T<=0||Q<=0)break;
    if(!trig&&f/thr>=0.01) trig=true;
    if(held&&c.graduated&&tr.b>=c.gradBlock){ const o=sellOut(Q,T,held)*(1-CF)*(1-AGG);
      (c.graduated?g:dd).push(o/1e18-spent-GAS); held=0; break; } }
  if(held){ const o=sellOut(Q,T,held)*(1-CF)*(1-AGG); (c.graduated?g:dd).push(o/1e18-spent-GAS); } }
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
const gA=avg(g), dA=avg(dd);
console.log(`\nf1 ENTRY ECONOMICS (1-block latency not modelled here; entry on next trade)`);
console.log(`  graduated: n=${g.length}  avg ${gA.toFixed(5)} ETH   total ${(gA*g.length).toFixed(3)}`);
console.log(`  died:      n=${dd.length}  avg ${dA.toFixed(5)} ETH   total ${(dA*dd.length).toFixed(3)}`);
console.log(`  base rate among f1-reaching curves: ${(g.length/(g.length+dd.length)*100).toFixed(3)}%`);
console.log(`  breakeven precision: ${(-dA/(gA-dA)*100).toFixed(2)}%`);
console.log(`  enter-everything net: ${(gA*g.length+dA*dd.length).toFixed(3)} ETH over ${g.length+dd.length} positions`);
