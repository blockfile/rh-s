'use strict';
// f1 entry on the 48h cohort WITH fill latency, and with the creator filter
// (the one leg of the composite rule that needs no buyer data).
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const netQ = (t) => Number(t.q) - Number(t.f || 0) - Number(t.x || 0);
const buyOut=(Q,T,q)=>T*q/(Q+q), sellOut=(Q,T,t)=>Q*t/(T+t);
function solve(tr){const b=tr.filter(x=>x.buy).slice(0,2); if(b.length<2)return null;
  const q1=netQ(b[0]),t1=Number(b[0].t),q2=netQ(b[1]),t2=Number(b[1].t),dn=t1*q2-t2*q1;
  if(!(Math.abs(dn)>0))return null; const Q0=t2*q1*(q1+q2)/dn; if(!(Q0>0)||!isFinite(Q0))return null;
  const T0=t1*(Q0+q1)/q1; return (T0>0&&isFinite(T0))?{Q0,T0}:null;}
function cost(tr){const r=tr.filter(x=>x.buy&&Number(x.q)>0).map(x=>(Number(x.f||0)+Number(x.x||0))/Number(x.q)).sort((a,b)=>a-b);
  return r.length?r[Math.floor(r.length/2)]:0.03;}
const AGG=0.01,GAS=0.00008,SIZE=0.1;
const C=d.curves;
const byC=new Map();
for(const c of C){ if(!byC.has(c.creator)) byC.set(c.creator,[]); byC.get(c.creator).push(c.createdBlock); }
for(const v of byC.values()) v.sort((a,b)=>a-b);
const prior=c=>byC.get(c.creator).filter(b=>b<c.createdBlock).length;

function run(LAT, creatorFilter){
  let g=[],dd=[];
  for(const c of C){
    if(creatorFilter && prior(c)!==0) continue;
    const r=solve(c.trades); if(!r)continue; const thr=Number(c.gradThreshold); if(!(thr>0))continue;
    const CF=cost(c.trades);
    let Q=r.Q0,T=r.T0,f=0,trigB=null;
    for(const tr of c.trades){ const q=netQ(tr),t=Number(tr.t);
      if(tr.buy){Q+=q;T-=t;f+=q;}else{Q-=q;T+=t;f-=q;}
      if(T<=0||Q<=0)break;
      if(f/thr>=0.01){trigB=tr.b;break;} }
    if(trigB===null)continue;
    Q=r.Q0;T=r.T0;f=0; let held=0,spent=0;
    for(const tr of c.trades){
      if(!held && tr.b>trigB+LAT-1){ const net=SIZE*1e18*(1-AGG)*(1-CF); const got=buyOut(Q,T,net);
        if(!(got>0))break; held=got;spent=SIZE+GAS;Q+=net;T-=got;f+=net; }
      const q=netQ(tr),t=Number(tr.t);
      if(tr.buy){Q+=q;T-=t;f+=q;}else{Q-=q;T+=t;f-=q;}
      if(T<=0||Q<=0)break;
      if(held&&c.graduated&&tr.b>=c.gradBlock){const o=sellOut(Q,T,held)*(1-CF)*(1-AGG);
        (c.graduated?g:dd).push(o/1e18-spent-GAS);held=0;break;} }
    if(held){const o=sellOut(Q,T,held)*(1-CF)*(1-AGG);(c.graduated?g:dd).push(o/1e18-spent-GAS);}
  }
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  const n=g.length+dd.length, gA=avg(g), dA=avg(dd), tot=gA*g.length+dA*dd.length;
  return {n, ng:g.length, prec:g.length/n*100, gA, dA, tot, per:tot/n, be:-dA/(gA-dA)*100};
}
console.log('48h cohort — f1 entry (1% funding), position 0.1 ETH\n');
for(const cf of [false,true]){
  console.log(cf ? 'WITH creator filter (0 prior launches)' : 'ENTER EVERYTHING (no selector)');
  console.log('  lat(blk)  positions   grads   prec%   avgGrad   avgDied    per-pos      TOTAL   breakeven%');
  for(const L of [0,1,2,5,10]){
    const r=run(L,cf);
    console.log(`  ${String(L).padStart(6)}  ${String(r.n).padStart(9)} ${String(r.ng).padStart(7)}  ${r.prec.toFixed(3).padStart(6)}` +
      `  ${r.gA.toFixed(4).padStart(8)}  ${r.dA.toFixed(5).padStart(8)}  ${r.per.toFixed(6).padStart(9)}  ${r.tot.toFixed(2).padStart(9)}   ${r.be.toFixed(2).padStart(7)}`);
  }
  console.log('');
}
