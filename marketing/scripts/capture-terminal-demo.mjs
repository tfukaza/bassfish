import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {connectDaemon} from '../../dist/daemon.js';
import {doltBinary, packageRoot} from '../../dist/config.js';

const exec=promisify(execFile);
const output=fileURLToPath(new URL('../video/',import.meta.url));
const dir=await mkdtemp('/private/tmp/bf-film-');
const repo=join(dir,'repo'), data=join(dir,'data');
const clients=[], trace=[];
const apiBefore=`const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  throw new Error('Route not found');\n}\n`;
const apiAfter=apiBefore.replace("  throw new Error", "  if (path === '/v2/items') return { items, total: items.length };\n  throw new Error");
const clientBefore=`import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/items');\n}\n`;
const clientAfter=clientBefore.replace("return request('/items');","return request('/v2/items').items;");
const testSource=`import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {get} from './api.mjs';\nimport {loadItems} from './client.mjs';\ntest('existing /items still returns an array', () => {\n  assert(Array.isArray(get('/items')));\n  assert.equal(get('/items')[0].id, 1);\n});\ntest('/v2/items includes pagination metadata', () => {\n  const result = get('/v2/items');\n  assert.deepEqual(result, {items: get('/items'), total: 1});\n});\ntest('client uses /v2/items and returns its items', () => {\n  const calls = [];\n  const result = loadItems(path => { calls.push(path); return get(path); });\n  assert.deepEqual(calls, ['/v2/items']);\n  assert.deepEqual(result, get('/items'));\n});\n`;
try {
 await exec('git',['init',repo]);
 await writeFile(join(repo,'api.mjs'),apiBefore);
 await writeFile(join(repo,'client.mjs'),clientBefore);
 await writeFile(join(repo,'demo.test.mjs'),testSource);
 async function client(name){
  const c=new Client({name:'bassfish-scripted-demo',version:'1.0.0'});
  clients.push(c);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(packageRoot,'dist/cli.js'),'mcp','--workspace',repo,'--name',name],
   env:{...process.env,BASSFISH_DATA_DIR:data,BASSFISH_DOLT_BIN:doltBinary()},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  await c.connect(transport);
  return {name,c};
 }
 const a=await client('api-agent'),b=await client('client-agent');
 async function call(agent,name,args={}){
  const result=await agent.c.callTool({name,arguments:args});
  const body=result.structuredContent??JSON.parse(result.content.find(x=>x.type==='text').text);
  trace.push({actor:agent.name,tool:name,input:args,output:body});
  assert(!result.isError,JSON.stringify(body));
  return body;
 }
 const sa=await call(a,'getSession'),sb=await call(b,'getSession');
 assert.equal(sa.projectId,sb.projectId);
 assert.notEqual(sa.identityId,sb.identityId);
 const thread=await call(a,'createThread',{title:'API pagination',description:''});
 async function claim(agent){
  const offer=await call(agent,'requestTurn',{target:{type:'thread',id:thread.threadId}});
  assert.equal(offer.state,'offered');
  return call(agent,'claimTurn',{offerId:offer.offerId});
 }
 async function post(agent,turn,body){
  const result=await call(agent,'commitTurn',{turn:{id:turn.turn.id,fencingToken:turn.turn.fencingToken},baseRevision:turn.snapshot.revision,mutation:{kind:'appendMessage',body}});
  return {body,baseRevision:turn.snapshot.revision,result};
 }
 const proposal=await post(a,await claim(a),'Adding pagination: /items will return { items, total }.');
 const bFirst=await claim(b);
 assert.equal(bFirst.page.messages.at(-1).body,proposal.body);
 const objection=await post(b,bFirst,'loadItems() expects an array. Keep /items; add /v2/items.');
 const aSecond=await claim(a);
 assert.equal(aSecond.page.messages.at(-1).body,objection.body);
 const agreement=await post(a,aSecond,'Agreed. /items stays unchanged. Adding /v2/items.');
 const bSecond=await claim(b);
 assert.equal(bSecond.page.messages.at(-1).body,agreement.body);
 const followup=await post(b,bSecond,"I'll switch loadItems() to /v2/items.");
 // Scripted coding activity in the disposable fixture, after both clients agree.
 await writeFile(join(repo,'api.mjs'),apiAfter);
 await writeFile(join(repo,'client.mjs'),clientAfter);
 const tests=await exec(process.execPath,['--test','--test-reporter=spec','demo.test.mjs'],{cwd:repo});
 assert.match(tests.stdout,/pass 3/);
 assert.match(tests.stdout,/fail 0/);
 const final=await claim(a);
 assert.deepEqual(final.page.messages.map(m=>m.body),[proposal,objection,agreement,followup].map(m=>m.body));
 await call(a,'releaseTurn',{turn:{id:final.turn.id,fencingToken:final.turn.fencingToken}});
 const demo={
  kind:'Scripted terminal session with captured real Bassfish MCP calls',capturedAt:new Date().toISOString(),
  agents:[a.name,b.name],thread:'API pagination',messages:final.page.messages.map(m=>({name:m.name,body:m.body,sequence:m.sequence})),
  reads:{clientFirst:bFirst.page.messages.map(m=>m.body),apiSecond:aSecond.page.messages.map(m=>m.body),clientSecond:bSecond.page.messages.map(m=>m.body)},
  writes:[proposal,objection,agreement,followup].map(p=>({baseRevision:p.baseRevision,result:p.result})),
  files:{apiBefore,apiAfter,clientBefore,clientAfter,testSource},tests:{passed:3,failed:0,stdout:tests.stdout},
  transcript:trace
 };
 await mkdir(output,{recursive:true});
 await writeFile(join(output,'session.json'),JSON.stringify(demo,null,2)+'\n');
 // A browser-importable subset; the full request/result evidence stays in session.json.
 await writeFile(join(output,'session-data.mjs'),'export const demo = '+JSON.stringify({messages:demo.messages,writes:demo.writes,tests:demo.tests,files:demo.files},null,2)+';\n');
 console.log(`Captured ${trace.length} real MCP calls, ${demo.messages.length} shared messages, and ${demo.tests.passed} passing fixture tests.`);
} finally {
 await Promise.allSettled(clients.map(c=>c.close()));
 try {
  const admin=await connectDaemon(data);
  const health=await admin.call('getHealth');
  await admin.call('stopDaemon');admin.close();
  const until=performance.now()+10000;
  while(performance.now()<until){try{process.kill(health.pid,0);}catch{break;}await delay(50);}
 } catch { /* No daemon to stop if startup failed. */ }
 await rm(dir,{recursive:true,force:true});
}
