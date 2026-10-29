// Four real host seat views + watcher: live public components, constant hidden-point
// reminder, own-private totals, no opponent disclosures, and the normal full win reveal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from '../server/node_modules/ws/wrapper.mjs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createGame } from '../src/lib/game/board.ts';
import { publicScoreBreakdown, publicVP } from '../src/lib/game/rules.ts';
const dir=mkdtempSync(path.join(tmpdir(),'emberisle-public-score-'));
const port=Number(process.env.VITE_PORT||18559),sockets=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
let host,browser;
const g=createGame({humans:[{name:'Ember'},{name:'Tide'},{name:'Pine'},{name:'Moss'}],bots:0,seed:559});
g.phase='main';g.rollOff=null;g.current='p0';g.log=[];
const buildings=[['p0','stronghold'],['p0','stronghold'],['p0','outpost'],['p0','outpost'],['p1','outpost'],['p1','outpost'],['p2','stronghold'],['p3','outpost']];
buildings.forEach(([playerId,kind],i)=>g.vertices[i].building={playerId,kind});
g.longestRoad='p1';g.largestArmy='p2';g.players[2].knightsPlayed=3;
g.players.forEach((p,i)=>{p.hidden.vp=[2,1,3,0][i];p.hidden.knight=1;p.resources={timber:0,clay:0,wool:0,grain:6,ore:4};});
const expected=g.players.map(p=>({parts:publicScoreBreakdown(g,p.id),public:publicVP(g,p.id),hidden:p.hidden.vp}));
for(const code of ['PSAA','PSAB']){
 const game=structuredClone(g);if(code==='PSAB')game.players.forEach(p=>p.hidden.vp=0);
 const seats=game.players.map((p,i)=>({id:`s${i}`,name:p.name,color:p.color,ready:true,pid:p.id,secret:`${code}-${p.id}`}));
 writeFileSync(path.join(dir,`${code}.json`),JSON.stringify({code,host:'s0',next:4,chat:[],chatSeq:0,game,seats,recoveryPids:[],shape:2,savedAt:Date.now()}));
}
const vite=await createServer({server:{host:'127.0.0.1',port,strictPort:true},logLevel:'error'});
try{
 host=spawn(process.execPath,['--import','./register.mjs','host.mjs'],{cwd:new URL('../server/',import.meta.url),env:{...process.env,PORT:'0',ROOMS_DIR:dir,GRACE_MS:'600000',HOLD_MS:'600000',TURN_MS:'600000'},stdio:['ignore','pipe','pipe']});
 const hostPort=await new Promise((resolve,reject)=>{host.stdout.on('data',d=>{const m=String(d).match(/listening (\d+)/);if(m)resolve(Number(m[1]));});host.on('exit',c=>reject(Error(`host ${c}`)));});
 async function client(code,pid){
  const ws=new WebSocket(`ws://127.0.0.1:${hostPort}`),messages=[];sockets.push(ws);ws.on('message',d=>messages.push(JSON.parse(String(d))));await new Promise(r=>ws.on('open',r));
  ws.send(JSON.stringify(pid===null?{type:'hello',code,watch:true}:{type:'hello',code,secret:`${code}-${pid}`}));
  const next=async seq=>{for(let i=0;i<300;i++){const m=messages.find(m=>m.type==='state'&&m.game.seq>=seq);if(m)return structuredClone(m);const err=messages.find(m=>m.type==='error');if(err)throw Error(err.message);await wait(10);}throw Error('state timeout');};
  return{ws,next,state:await next(0)};
 }
 const ids=['p0','p1','p2','p3',null],peers=[],zeros=[];
 for(const id of ids){peers.push(await client('PSAA',id));zeros.push(await client('PSAB',id));}
 const stages={before:peers.map(p=>p.state),zero:zeros.map(p=>p.state)};
 for(const [i,view] of stages.before.entries())for(const p of view.game.players)assert.equal(p.hidden.vp,p.id===ids[i]?expected[Number(p.id.slice(1))].hidden:0);
 let actor=peers[0].state;
 for(const [label,vertexId] of [['live',g.vertices[2].id],['over',g.vertices[3].id]]){
  peers[0].ws.send(JSON.stringify({...actor.actionStamp,cid:crypto.randomUUID(),type:'place',kind:'stronghold',id:vertexId}));
  stages[label]=await Promise.all(peers.map(p=>p.next(actor.game.seq+1)));actor=stages[label][0];
 }
 assert.equal(stages.live[0].game.phase,'main');assert.equal(stages.over[0].game.phase,'over');
 for(const ws of sockets)ws.terminate();host.kill('SIGKILL');
 await vite.listen();browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});mkdirSync('test-results',{recursive:true});
 const errors=[];let hint;
 for(const [width,height,reduced] of [[390,844,false],[1280,720,false],[844,390,true]]){
  const context=await browser.newContext({viewport:{width,height},hasTouch:width<1000,reducedMotion:reduced?'reduce':'no-preference'});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(()=>window.__emberisle);
  const load=async(view,i)=>page.evaluate(({view,i})=>{const store=window.__emberisle;store.setState({spectator:i===4,menuFor:null,chatOpen:false,code:'PSAA',seatId:`s${i}`});store.getState().loadState(view.game,view.you??'',i===0,'PSAA');},{view,i});
  for(let i=0;i<ids.length;i++){
   await load(stages.before[i],i);await page.getByTestId('hidden-point-hint').waitFor();
   const text=await page.getByTestId('hidden-point-hint').textContent();hint??=text;assert.equal(text,hint);
   const beforeHole=await page.evaluate(()=>window.__isle?.insets());
   for(let p=0;p<4;p++){
    await page.locator(`[data-menu-trigger="p${p}"]`).click();
    const menu=page.getByTestId('player-menu');await menu.getByTestId('score-breakdown').waitFor();
    const parts=await menu.locator('[data-component]').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.dataset.component,Number(n.dataset.points)])));
    assert.deepEqual(parts,expected[p].parts);assert.equal(Object.values(parts).reduce((n,k)=>n+k,0),expected[p].public);
    if(i===p){assert.equal(await menu.getByTestId('private-points').textContent(),String(expected[p].hidden));assert.equal(await menu.getByTestId('private-total').textContent(),String(expected[p].public+expected[p].hidden));}
    else{assert.equal(await menu.getByTestId('private-points').count(),0);assert.equal(await menu.getByTestId('private-total').count(),0);assert.doesNotMatch(await menu.getByTestId('menu-facts').textContent(),/Your fortunes|points ×/);}
    if(i===4)assert.equal(await menu.getByRole('button').count(),0);
    await page.keyboard.press('Escape');
   }
   // An already-open detail recomputes when the host broadcasts a score change.
   await page.locator('[data-menu-trigger="p0"]').click();
   await page.evaluate(view=>window.__emberisle.getState().loadState(view.game,view.you??'',false,'PSAA'),stages.live[i]);
   await page.waitForFunction(()=>document.querySelector('[data-component="outposts"]')?.dataset.points==='1');
   assert.equal(await page.locator('[data-component="strongholds"]').getAttribute('data-points'),'6');
   await page.keyboard.press('Escape');
   await load(stages.zero[i],i);assert.equal(await page.getByTestId('hidden-point-hint').textContent(),hint);
   await load(stages.over[i],i);await page.getByTestId('win-screen').waitFor();
   for(let p=0;p<4;p++){
    const row=page.locator(`[data-testid="win-row"][data-player="p${p}"]`);
    if(width<1000){ // #748: phones show compact summaries; the hidden points sit in the expanded breakdown.
     await row.getByTestId('win-toggle').click();
     assert.equal(await row.locator('[data-component="hidden"]').getAttribute('data-points'),String(expected[p].hidden));
    }else{const cells=await row.locator('td').allTextContents();assert.equal(cells[5],String(expected[p].hidden));}
   }
   await page.getByTestId('win-look').click();
   await page.locator('[data-menu-trigger="p1"]').click();assert.equal(await page.getByTestId('private-points').textContent(),'1');await page.keyboard.press('Escape');
  }
  await page.screenshot({path:`test-results/public-score-${width}.png`});await context.close();
  console.log(`ok ${width}x${height}${reduced?' reduced':''}: four seats + watcher; public components reconcile; live updates; own-only hidden points; identical zero/many reminder; full end reveal`);
 }
 // #748: compact phone results at four phone sizes (touch), then the desktop table.
 const final=stages.over[0].game,rank=final.players.map(p=>({id:p.id,total:publicVP(final,p.id)+p.hidden.vp,parts:publicScoreBreakdown(final,p.id),hidden:p.hidden.vp}));
 const order=[...rank].sort((a,b)=>Number(b.id===final.winner)-Number(a.id===final.winner)||b.total-a.total).map(r=>r.id);
 for(const [width,height] of [[390,844],[844,390],[440,956],[956,440],[1280,720]]){
  const phone=width<1000;
  const context=await browser.newContext({viewport:{width,height},hasTouch:phone,isMobile:phone});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>m.type()==='error'&&errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>window.__emberisle);
  const longName='Moss the Extraordinarily Long-Named Wanderer of the Eastern Isles';
  await page.evaluate(({view,longName})=>{const s=window.__emberisle;s.setState({mode:'online',seats:[{id:'s0',name:'Ember',host:true},{id:'s1',name:'Tide',host:false}],spectator:false,menuFor:null,chatOpen:false,code:'PSAA',seatId:'s0'});const g=structuredClone(view.game);g.players[3].name=longName;s.getState().loadState(g,view.you??'',true,'PSAA');},{view:stages.over[0],longName});
  const screen=page.getByTestId('win-screen');await screen.waitFor();
  const inView=async(loc,what)=>{await loc.scrollIntoViewIfNeeded();const b=await loc.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=width+0.5&&b.y+b.height<=height+0.5,`${what} outside ${width}x${height}: ${JSON.stringify(b)}`);return b;};
  await inView(screen.locator('> div'),'panel');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page scrolls horizontally');
  if(!phone){
   assert.equal(await page.getByTestId('win-compact').count(),0);assert.equal(await page.locator('[data-testid="win-screen"] table').count(),1);
   assert.equal(await page.getByTestId('win-row').count(),4);console.log(`ok ${width}x${height}: desktop table retained`);await context.close();continue;
  }
  assert.equal(await page.locator('[data-testid="win-screen"] table').count(),0);
  const wrap=page.getByTestId('win-table-wrap'),dims=await wrap.evaluate(el=>({sw:el.scrollWidth,cw:el.clientWidth}));
  assert.ok(dims.sw<=dims.cw+1,`results scroll horizontally ${dims.sw}>${dims.cw}`);
  const rows=page.getByTestId('win-row');assert.equal(await rows.count(),4);
  assert.deepEqual(await rows.evaluateAll(n=>n.map(r=>r.dataset.player)),order);
  assert.equal(await page.getByTestId('win-detail').count(),0);
  const name3=page.locator('[data-testid="win-row"][data-player="p3"] [data-testid="win-toggle"] span').nth(1);
  for(const id of order){
   const row=page.locator(`[data-testid="win-row"][data-player="${id}"]`),toggle=row.getByTestId('win-toggle'),r=rank.find(x=>x.id===id);
   const tb=await inView(toggle,`summary ${id}`);assert.ok(tb.height>=44,`target ${tb.height}px`);
   const total=await inView(row.getByTestId('win-total'),`total ${id}`);assert.equal(await row.getByTestId('win-total').textContent(),String(r.total));
   const name=await row.locator('span').nth(1).boundingBox();assert.ok(name.x+name.width<=total.x+0.5,'name overlaps total');
   assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await row.getByTestId('win-detail').count(),0);
   await toggle.click(); // tap
   assert.equal(await toggle.getAttribute('aria-expanded'),'true');
   const parts=await row.locator('[data-component]').evaluateAll(n=>Object.fromEntries(n.map(x=>[x.dataset.component,Number(x.dataset.points)])));
   assert.deepEqual(parts,{...r.parts,hidden:r.hidden});assert.equal(Object.values(parts).reduce((a,b)=>a+b,0),r.total);
   const text=await row.getByTestId('win-detail').textContent();
   for(const k of ['outpost','stronghold','Longest path','Largest army','Revealed hidden points'])assert.ok(text.includes(k),`${id} detail lacks ${k}`);
   assert.ok(text.includes(`${r.parts.strongholds/2} stronghold`)&&text.includes(`${r.parts.strongholds} point`),`${id} stronghold count/points`);
   await inView(row.getByTestId('win-detail'),`detail ${id}`);
   await toggle.focus();await page.keyboard.press('Enter'); // keyboard collapse
   assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await row.getByTestId('win-detail').count(),0);
   await page.keyboard.press('Space');assert.equal(await toggle.getAttribute('aria-expanded'),'true'); // keyboard expand
   await page.keyboard.press('Space');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  }
  assert.ok(/Extraordinarily/.test(await name3.textContent()));
  for(const t of ['win-look','win-again','win-menu'])await inView(page.getByTestId(t),t);
  // Focus stays trapped, and Look around / Show scores still work.
  for(let i=0;i<14;i++){await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.querySelector('[data-testid="win-screen"]').contains(document.activeElement)),'focus escaped');}
  await page.getByTestId('win-look').click();await page.getByTestId('win-show').click();await screen.waitFor();
  await page.evaluate(()=>window.__emberisle.setState({seatId:'s1'})); // a non-host seat gets no rematch
  await page.getByTestId('win-waiting').waitFor();assert.equal(await page.getByTestId('win-again').count(),0);await inView(page.getByTestId('win-menu'),'win-menu');
  await page.screenshot({path:`test-results/public-score-compact-${width}x${height}.png`});await context.close();
  console.log(`ok ${width}x${height} touch: compact summaries, no sideways scroll, ${rank.length} players expand by tap and keyboard, components reconcile with totals`);
 }
 assert.equal(hint,'Hidden fortunes may add points.');assert.deepEqual(errors,[]);console.log('public-score-prove: all passed');
}finally{await browser?.close();await vite.close();for(const ws of sockets)ws.terminate();host?.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
