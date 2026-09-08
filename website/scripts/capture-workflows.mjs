import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {connectDaemon} from '../../dist/daemon.js';
import {doltBinary,packageRoot} from '../../dist/config.js';

const exec=promisify(execFile),dir=await mkdtemp('/private/tmp/bf-workflows-');
const repo=join(dir,'repo'),data=join(dir,'data'),clients=[];
const evidence={kind:'Scripted examples validated through isolated Bassfish MCP clients',checks:[],messages:[],note:''};
async function client(name){
 const c=new Client({name:'bassfish-workflow-fixture',version:'1.0.0'});clients.push(c);
 await c.connect(new StdioClientTransport({command:process.execPath,args:[join(packageRoot,'dist/cli.js'),'mcp','--workspace',repo,'--name',name],env:{...process.env,BASSFISH_DATA_DIR:data,BASSFISH_DOLT_BIN:doltBinary()},stderr:'pipe'}));
 return c;
}
async function call(c,name,args={}){const r=await c.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent;}
function checked(name,condition){assert(condition,name);evidence.checks.push(name);}
try {
 await exec('git',['init',repo]);
 const api=await client('api-agent');
 const initial=await call(api,'getContext'); checked('One session starts online',initial.agentName==='api-agent');
 let ui=await client('client-agent');
 checked('A second connected session joins',(await call(api,'getContext')).agents.some(a=>a.name==='client-agent'&&a.online));
 const thread=await call(api,'createResource',{resourceType:'thread',title:'API pagination'});
 const target={type:'thread',threadId:thread.threadId};
 async function acquire(c,t=target){const r=await call(c,'acquireTurn',{target:t,timeoutMs:0});assert.equal(r.state,'claimed');return r;}
 async function post(c,body,mentions={agents:[],here:false}){const turn=await acquire(c);await call(c,'commitTurn',{turnToken:turn.turnToken,mutation:{kind:'appendMessage',body,mentions}});}
 async function read(c){const t=await acquire(c);await call(c,'releaseTurn',{turnToken:t.turnToken});return t.messages;}
 await post(ui,'What’s the response format?');
 checked('The API agent reads the client’s question',(await read(api)).at(-1).body==='What’s the response format?');
 await post(api,'Use items + nextCursor. Null means the last page.');
 checked('The client reads the API agent’s answer',(await read(ui)).at(-1).body==='Use items + nextCursor. Null means the last page.');
 await ui.close();
 for(let i=0;i<30;i++){if(!(await call(api,'getContext',{includeOfflineAgents:true})).agents.find(a=>a.name==='client-agent').online)break;await delay(100);}
 checked('Closing the client marks it offline',!(await call(api,'getContext',{includeOfflineAgents:true})).agents.find(a=>a.name==='client-agent').online);
 checked('Shared messages survive disconnection',(await read(api)).length===2);
 ui=await client('client-agent');
 const reviewer=await client('reviewer'),offline=await client('offline-agent');
 await read(ui);await read(offline);await offline.close();
 for(let i=0;i<30;i++){if(!(await call(api,'getContext',{includeOfflineAgents:true})).agents.find(a=>a.name==='offline-agent').online)break;await delay(100);}
 await post(api,'@reviewer, can you check the pagination change?',{agents:['reviewer'],here:false});
 checked('Structured direct mention delivers a notification',(await call(reviewer,'notifications',{action:'list'})).notifications.some(n=>n.reasons.includes('direct_mention')));
 checked('The reviewer reads the mentioned thread',(await read(reviewer)).at(-1).body.includes('@reviewer'));
 await post(reviewer,'Checked the last-page behavior. Looks good.');
 await post(reviewer,'@here, review complete.',{agents:[],here:true});
 for(const [name,c] of [['api-agent',api],['client-agent',ui]])checked(`@here reaches online follower ${name}`,(await call(c,'notifications',{action:'list'})).notifications.some(n=>n.reasons.includes('here')));
 checked('@here excludes its sender',!(await call(reviewer,'notifications',{action:'list'})).notifications.some(n=>n.reasons.includes('here')));
 const offlineAgain=await client('offline-agent');
 checked('@here excludes offline followers',!(await call(offlineAgain,'notifications',{action:'list'})).notifications.some(n=>n.reasons.includes('here')));
 evidence.messages=(await read(api)).map(m=>({author:m.author,body:m.body}));
 const note=await call(api,'createResource',{resourceType:'note',path:'api-plan',title:'API pagination plan',body:'# API pagination\n'});
 const nt={type:'note',noteId:note.noteId};
 const first=await acquire(api,nt),queued=await call(ui,'acquireTurn',{target:nt,timeoutMs:0});
 checked('The client waits while API holds the note',queued.state!=='claimed'&&Boolean(queued.requestToken));
 await call(api,'commitTurn',{turnToken:first.turnToken,mutation:{kind:'appendNoteBody',body:'Response: items + nextCursor\n'}});
 const second=await call(ui,'acquireTurn',{requestToken:queued.requestToken,timeoutMs:1000});
 checked('The queued client receives the latest note',second.state==='claimed'&&second.text.includes('Response: items + nextCursor'));
 await call(ui,'commitTurn',{turnToken:second.turnToken,mutation:{kind:'appendNoteBody',body:'Hide Next when nextCursor is null\n'}});
 const final=await acquire(api,nt);evidence.note=final.text;
 checked('Both note edits are retained',final.text.includes('Response: items + nextCursor')&&final.text.includes('Hide Next when nextCursor is null'));
 await call(api,'releaseTurn',{turnToken:final.turnToken});
 // Check the actual presentation against captured content; never publish tokens or raw tool results.
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 for(const m of evidence.messages)assert(html.includes(m.body),`Missing captured message: ${m.body}`);
 for(const line of ['Response: items + nextCursor','Hide Next when nextCursor is null'])assert(html.includes(line));
 await mkdir(new URL('../fixtures/',import.meta.url),{recursive:true});
 await writeFile(new URL('../fixtures/workflows.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
 console.log(`Validated ${evidence.checks.length} workflow behaviors; saved sanitized fixture evidence.`);
} finally {
 await Promise.allSettled(clients.map(c=>c.close()));
 try{const admin=await connectDaemon(data);const health=await admin.call('getHealth');await admin.call('stopDaemon');admin.close();for(let i=0;i<100;i++){try{process.kill(health.pid,0);}catch{break;}await delay(50);}}catch{}
 await rm(dir,{recursive:true,force:true});
}
