// Real hosted winning actions -> private pre-win views -> saved/restarted rooms -> browser win screens and reload.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from '../server/node_modules/ws/wrapper.mjs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createGame } from '../src/lib/game/board.ts';
import { legalSettle, publicVP } from '../src/lib/game/rules.ts';
import { toIntent } from '../src/lib/net/table.ts';
const dir=mkdtempSync(path.join(tmpdir(),'emberisle-win-action-'));
const port=Number(process.env.VITE_PORT||18551);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let host,hostPort;const sockets=[];
const cases=[['WAAB','outpost','Built an outpost',7],['WAAC','stronghold','Upgraded to a stronghold',7],['WAAD','longestPath','Took longest path',7],['WAAE','largestArmy','Took largest army',7],['WAAF','pointFortune','Drew a point fortune',7],['WAAG','pointFortune','Drew a point fortune',10],['WAAH','largestArmy','Took largest army',7,8]];
const fixtures=[];
function trail(g,n,avoid=new Set()){
 for(const start of g.vertices){
  const used=new Set([start.id]),edges=[];
  const walk=v=>{if(edges.length===n)return true;for(const e of g.edges){if(e.va!==v&&e.vb!==v||avoid.has(e.id))continue;const next=e.va===v?e.vb:e.va;if(used.has(next))continue;used.add(next);edges.push(e);if(walk(next))return true;edges.pop();used.delete(next);}return false;};
  if(walk(start.id))return edges;
 }throw Error('no trail');
}
function points(g,n,avoid=new Set()){
 for(const v of g.vertices){if(avoid.has(v.id)||v.building)continue;const kind=n>=2?'stronghold':'outpost';v.building={playerId:'p0',kind};n-=kind==='stronghold'?2:1;if(!n)return;}
 throw Error('not enough vertices');
}
for(const [code,trigger,text,target,earned=target] of cases){
 const g=createGame({humans:[{name:'Ember'},{name:'Tide'},{name:'Pine'},{name:'Moss'}],bots:0,seed:55});
 g.phase='main';g.rollOff=null;g.current='p0';g.log=[];g.victoryTarget=target;
 const me=g.players[0];me.resources={timber:4,clay:4,wool:4,grain:6,ore:6};let action;
 if(trigger==='outpost'){
  const e=g.edges[0];e.path='p0';const v=e.va;
  const avoid=new Set([v,...g.edges.filter(e=>e.va===v||e.vb===v).flatMap(e=>[e.va,e.vb])]);points(g,earned-1,avoid);
  assert(legalSettle(g,'p0',false).includes(v));action={type:'buildOutpost',vertexId:v};
 }else if(trigger==='stronghold'){
  const a=g.vertices[0],b=g.vertices[1];a.building={playerId:'p0',kind:'outpost'};b.building={playerId:'p0',kind:'outpost'};points(g,earned-3);action={type:'buildStronghold',vertexId:a.id};
 }else if(trigger==='longestPath'){
  const mine=trail(g,6);const other=trail(g,5,new Set(mine.map(e=>e.id)));
  for(const e of mine.slice(0,5))e.path='p0';for(const e of other)e.path='p1';g.longestRoad='p1';
  points(g,earned-2,new Set(other.flatMap(e=>[e.va,e.vb])));action={type:'buildPath',edgeId:mine[5].id};
 }else if(trigger==='largestArmy'){
  points(g,earned-2);me.knightsPlayed=3;g.players[1].knightsPlayed=3;g.largestArmy='p1';me.hidden.knight=1;
  action={type:'playKnight',hexId:g.hexes.find(h=>h.id!==g.robberHex).id,stealFrom:null};
 }else{points(g,earned-1);g.deck=['vp',...g.deck];action={type:'buyCard'};}
 assert.equal(publicVP(g,'p0'),earned-(trigger==='longestPath'||trigger==='largestArmy'?2:1));
 // Even a stale pre-end snapshot field must never cross the public boundary.
 if(code==='WAAB')g.winReason={trigger:'pointFortune',points:0,target};
 const seats=g.players.map((p,i)=>({id:`s${i}`,name:p.name,color:p.color,ready:true,pid:p.id,secret:`${code}-${p.id}`}));
 writeFileSync(path.join(dir,`${code}.json`),JSON.stringify({code,host:'s0',next:4,chat:[],chatSeq:0,game:g,seats,recoveryPids:[],shape:2,savedAt:Date.now()}));
 fixtures.push({code,trigger,text,target,earned,action});
}
async function start(){
 let stderr='';host=spawn(process.execPath,['--import','./register.mjs','host.mjs'],{cwd:new URL('../server/',import.meta.url),env:{...process.env,PORT:'0',ROOMS_DIR:dir,SAVE_MS:'20',GRACE_MS:'600000',HOLD_MS:'600000',TURN_MS:'600000',ACT_CAP:'1000',ACT_RATE:'1000'},stdio:['ignore','pipe','pipe']});
 host.stderr.on('data',d=>stderr+=d);
 hostPort=await new Promise((resolve,reject)=>{host.stdout.on('data',d=>{const m=String(d).match(/listening (\d+)/);if(m)resolve(Number(m[1]));});host.on('exit',c=>reject(Error(`host ${c}: ${stderr}`)));});
}
async function client(code,pid){
 const ws=new WebSocket(`ws://127.0.0.1:${hostPort}`),messages=[];sockets.push(ws);
 ws.on('message',raw=>messages.push(JSON.parse(String(raw))));await new Promise(r=>ws.on('open',r));
 ws.send(JSON.stringify(pid===null?{type:'hello',code,watch:true}:{type:'hello',code,secret:`${code}-${pid}`}));
 const next=async(test)=>{for(let i=0;i<300;i++){const m=messages.find(test);if(m)return m;const error=messages.find(m=>m.type==='error');if(error)throw Error(error.message);await wait(10);}throw Error(`timed out ${code} ${pid}`);};
 const state=await next(m=>m.type==='state');return{ws,state,next};
}
const vite=await createServer({server:{host:'127.0.0.1',port,strictPort:true},logLevel:'error'});
let browser;
try{
 await start();
 for(const f of fixtures){
  const peers=[];for(const pid of ['p0','p1','p2','p3',null])peers.push(await client(f.code,pid));
  for(const peer of peers){assert.ok(!('winReason' in peer.state.game));assert.equal(peer.state.game.phase,'main');}
  const a=peers[0];a.ws.send(JSON.stringify({...a.state.actionStamp,cid:crypto.randomUUID(),...toIntent(f.action)}));
  for(const peer of peers){const end=await peer.next(m=>m.type==='state'&&m.game.phase==='over');assert.deepEqual(end.game.winReason,{trigger:f.trigger,points:f.earned,target:f.target});}
  for(let i=0;i<100;i++){if(JSON.parse(readFileSync(path.join(dir,`${f.code}.json`))).game.phase==='over')break;await wait(20);}
  const saved=JSON.parse(readFileSync(path.join(dir,`${f.code}.json`)));assert.equal(saved.game.winReason.trigger,f.trigger);
 }
 for(const ws of sockets)ws.terminate();host.kill('SIGKILL');await new Promise(r=>host.once('exit',r));await start();
 await vite.listen();browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});mkdirSync('test-results',{recursive:true});
 const errors=[];
 for(const [width,height,reduced,insets] of [[390,844,false],[440,956,false],[1280,720,false],[844,390,true],[956,440,false],[667,375,false,{top:0,right:44,bottom:21,left:44}]]){
  for(const f of fixtures){
   const context=await browser.newContext({viewport:{width,height},reducedMotion:reduced?'reduce':'no-preference',hasTouch:!!insets,isMobile:!!insets});
   await context.addInitScript(({code})=>{localStorage.setItem('emberisle-seat',JSON.stringify({code,secret:`${code}-p0`}));localStorage.setItem('emberisle-seat-live',code);},f);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   if(insets)await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride',{insets});
   await page.goto(`http://127.0.0.1:${port}/?host=${encodeURIComponent(`ws://127.0.0.1:${hostPort}`)}`);
   await page.getByTestId('win-action').waitFor();
   const expected=`${f.text}${f.trigger==='longestPath'||f.trigger==='largestArmy'?' (+2)':f.trigger==='pointFortune'?' (+1)':''} · ${f.earned} points, target ${f.target}.`;
   assert.equal(await page.getByTestId('win-action').textContent(),expected);
   await page.reload();await page.getByTestId('win-action').waitFor();assert.equal(await page.getByTestId('win-action').textContent(),expected);
   if(insets)await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride',{insets});
   const box=await page.getByTestId('win-action').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);
   const wrap=page.getByTestId('win-table-wrap');
   const wrapBox=await wrap.boundingBox();
   const dims=await wrap.evaluate(el=>({scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}));
   assert.ok(dims.scrollWidth<=dims.clientWidth+1,`table must not scroll horizontally: scrollWidth ${dims.scrollWidth} <= clientWidth ${dims.clientWidth}`);
   const compact=await page.getByTestId('win-compact').count()>0; // #748: phone summaries scroll vertically instead of fitting
   if(height<=480&&!compact){
    assert.ok(dims.scrollHeight<=dims.clientHeight,`table must not scroll vertically: scrollHeight ${dims.scrollHeight} <= clientHeight ${dims.clientHeight}`);
   }
   const rows=await page.getByTestId('win-row').all();assert.equal(rows.length,4);
   for(const r of rows){
    if(compact)await r.scrollIntoViewIfNeeded();
    const b=await r.boundingBox();
    if(height<=480)assert.ok(b&&b.y>=wrapBox.y&&b.y+b.height<=wrapBox.y+wrapBox.height+1,`row must fit within table wrap`);
    assert.ok(b&&b.y>=0&&b.y+b.height<=height,`row must fit within viewport height ${height}`);
    const total=await r.locator('[data-testid="win-total"]').boundingBox();
    assert.ok(total&&total.x>=wrapBox.x&&total.x+total.width<=wrapBox.x+wrapBox.width+1,`total column must fit within table wrap: total right ${total?.x+total?.width} <= wrap right ${wrapBox.x+wrapBox.width}`);
   }
   await page.screenshot({path:`test-results/win-action-${f.trigger}-${f.target}-${f.earned}-${width}${insets?'-insets':''}.png`});await context.close();
  }
  console.log(`ok ${width}x${height}${reduced?' reduced':''}${insets?' insets':''}: five winning triggers, seven-/ten-point targets and overshoot, persisted restart and browser reload`);
 }
 assert.deepEqual(errors,[]);console.log('win-action-prove: all passed; all seat/watcher views omit trigger before the win');
}finally{await browser?.close();await vite.close();for(const ws of sockets)ws.terminate();host?.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
