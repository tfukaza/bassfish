import {demo} from '../video/session-data.mjs';
// Shared artwork for print, web previews and the silent film.
export const C = {ink:'#242623',white:'#FAFAF8',mint:'#596650',muted:'#6A6F67',line:'#D4D7D0',panel:'#F0F1ED'};
export const TAGLINE='Headless inter-agent communication for agent teams';
export const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export const text=(x,y,s,size=24,fill=C.ink,weight=400,extra='')=>`<text x="${x}" y="${y}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;
const title=(x,y,s,size=64)=>text(x,y,s,size,C.ink,400,'letter-spacing="-2.2"');
export const rect=(x,y,w,h,fill=C.panel,r=0,stroke='none')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
export const line=(x1,y1,x2,y2,color=C.line,width=2)=>`<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
export const svg=(w,h,name,body,bg=C.white)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title"><title id="title">${esc(name)}</title>${bg?rect(0,0,w,h,bg):''}${body}</svg>`;
export const fish = (x,y,size,color=C.ink) => `<g transform="translate(${x} ${y}) scale(${size/200})"><path fill="${color}" fill-rule="evenodd" d="M8 64 C21 68 28 75 40 80 Q53 71 69 68 Q66 58 76 56 Q85 56 91 65 L96 57 L100 63 L105 52 L109 61 L115 49 L119 60 L126 52 L130 63 L136 59 L139 70 Q161 73 176 83 L191 93 L165 99 L191 96 Q184 109 167 116 Q150 123 130 122 L123 132 L112 123 Q92 124 77 117 L64 121 L68 111 Q52 104 40 96 Q28 105 8 111 Q17 87 8 64 Z M171 85 A2.3 2.3 0 1 0 171 89.6 A2.3 2.3 0 1 0 171 85 Z M151 82 Q169 103 146 117 Q158 103 151 82 Z"/></g>`;
export const logo=(x,y,size=64,color=C.ink,mark=color)=>fish(x,y,size,mark)+text(x+size+12,y+size*.66,'bassfish',size*.54,color,500,'letter-spacing="-1.2"');
export const mono=(x,y,s,size=18,color=C.muted)=>text(x,y,s,size,color,400,'style="font-family:Menlo,monospace"');
const arrow=(x1,y,x2)=>`<g data-connector="${x1},${y},${x2},${y}">${line(x1,y,x2,y)}<path d="M${x2-7} ${y-5} L${x2} ${y} L${x2-7} ${y+5}" fill="none" stroke="${C.line}" stroke-width="2"/></g>`;

export function overview(w=1600,h=480){
 const social=h===640;
 let b=social?logo(80,40,64):logo(80,38,280);
 if(social){
  b+=title(80,289,'Headless inter-agent',72)+title(80,374,'communication for agent teams',72);
  b+=text(80,560,'Local preview',19,C.muted);
 }else{
  b+=text(80,324,TAGLINE,38);
  b+=text(80,400,'Local preview',20,C.muted);
 }
 return svg(w,h,`Bassfish: ${TAGLINE}. Local preview.`,b);
}

export const workflowGeometry={centers:[200,680,1160],y:340,radius:7};
export function workflow(){
 const g=workflowGeometry;
 let b=title(72,152,'How agents take turns',58);
 g.centers.forEach((x,i)=>{
  b+=`<circle cx="${x}" cy="${g.y}" r="${g.radius}" fill="${C.mint}"/>`;
  if(i<2)b+=arrow(x+g.radius,g.y,g.centers[i+1]-g.radius);
  b+=text(x,414,['Claim','Read or write','Release'][i],32,C.ink,500,'text-anchor="middle"');
  const lines=[['Get the latest thread','or note and its revision.'],['Read the context; prepare','a revision-bound change.'],['Commit and release, or','release without writing.']][i];
  lines.forEach((s,j)=>b+=text(x,464+j*30,s,23,C.muted,400,'text-anchor="middle"'));
 });
 b+=text(72,666,'Each thread and note has its own floor.',21,C.muted);
 return svg(1360,768,'Agents claim the latest thread or note and its revision, read the context, then commit and release or release without writing. Each thread and note has its own floor.',b);
}

export function brandSheet(){
 let b=logo(72,42,100)+text(1028,108,'Brand reference',19,C.muted,400,'text-anchor="end"');
 b+=title(72,266,'Headless inter-agent',57)+title(72,334,'communication for agent teams',57);
 const colors=[['Canvas',C.white],['Text',C.ink],['Accent',C.mint]];
 colors.forEach(([name,c],i)=>{
  const x=72+i*330;
  b+=rect(x,453,294,100,c,0,i===0?C.line:'none')+text(x,592,name,23,C.ink,500)+mono(x,626,c,18);
 });
 b+=text(72,763,'Helvetica Neue',32,C.ink,500)+text(72,808,'Regular for headlines. Medium for the wordmark.',21,C.muted);
 b+=fish(750,690,228)+text(750,851,'Minimum icon: 32 px',20,C.muted);
 b+=text(72,985,'Chat and shared notes are available in the local preview.',21,C.muted);
 return svg(1100,1060,`Bassfish brand reference. ${TAGLINE}. Neutral canvas and charcoal text with an olive accent. Helvetica Neue. Local preview.`,b);
}

export const DURATION=25, FPS=30, GIF_START=6, GIF_DURATION=8;
export const VIDEO_WIDTH=1792, VIDEO_HEIGHT=748, GIF_WIDTH=896, GIF_HEIGHT=374;
export const snapshots=[0,2.8,6.8,9.8,12.8,14.8,16.8,19.3,21.5,22.6,23.7,24.9];
export const events=[
 [0,2,'Two agents are working on API pagination.'],
 [2,6,'The API agent proposes changing the response.'],
 [6,12,'The client agent reads it and flags a dependency.'],
 [12,16,'They agree to keep the existing endpoint.'],
 [16,21,'The client agent picks up the new endpoint.'],
 [21,DURATION,'They update the API and client.']
];
const terminal={bg:'#252925',bar:'#2D322C',ink:'#ECEFE8',muted:'#A2ADA0',green:'#BED8AA',selection:'#364333',red:'#D6AAA0'};
const r=(s,kind='normal',highlight=false)=>({s,kind,highlight});
const blank=()=>r('');
function wrap(s,n=48){
 const result=[];let current='';
 for(const word of s.split(' ')){if(current&&current.length+word.length+1>n){result.push(current);current=word;}else current+=(current?' ':'')+word;}
 if(current)result.push(current);return result;
}
function message(index,highlight=true){return wrap(demo.messages[index].body).map(s=>r(s,'message',highlight));}
function receipt(index){return r(`saved · revision ${demo.writes[index].result.revision} · released`,'muted');}
const claimRows=index=>[r('bassfish.acquire_floor','tool'),r('bassfish.claim_floor','tool'),r(`thread: API pagination · revision ${demo.writes[index].baseRevision}`,'muted')];
function pane(x,name,rows,active,t){
 const y=0,w=880,h=VIDEO_HEIGHT;
 let b=rect(x,y,w,h,terminal.bg,10)+rect(x,y,w,64,terminal.bar,10)+rect(x,y+40,w,24,terminal.bar);
 b+=text(x+30,y+40,`${name}  ~/demo`,24,active?terminal.ink:terminal.muted,400,'style="font-family:Menlo,monospace"');
 if(active)b+=rect(x+28,y+61,110,3,terminal.green);
 rows.forEach((row,i)=>{
  const baseline=y+109+i*37;
  if(row.highlight&&active)b+=rect(x+22,baseline-27,w-44,37,terminal.selection);
  const color=!active?terminal.muted:row.kind==='muted'?terminal.muted:row.kind==='tool'||row.kind==='add'||row.kind==='pass'?terminal.green:row.kind==='remove'?terminal.red:terminal.ink;
  b+=text(x+32,baseline,row.s,26,color,400,'style="font-family:Menlo,monospace"');
 });
 return b;
}
function leftRows(t){
 if(t<2)return [r('> Add pagination to /items.'),blank(),r('Read api.mjs','muted'),r("  if (path === '/items') return items;"),blank(),r('Checking with the client agent.','muted')];
 if(t<12)return [r('> Add pagination to /items.','muted'),blank(),...claimRows(0),blank(),r('bassfish.commit_and_done','tool'),...message(0,t<6),blank(),receipt(0)];
 if(t<21){
  const rows=[r('> Add pagination to /items.','muted'),blank(),...claimRows(2),blank(),r('client-agent:','muted'),...message(1,t<14)];
  if(t>=14)rows.push(blank(),r('bassfish.commit_and_done','tool'),...message(2),receipt(2));
  return rows;
 }
 return [r('Edit api.mjs','tool'),blank(),r('  /items stays unchanged.','muted'),blank(),r("+ if (path === '/v2/items')",'add'),r('+   return { items, total: items.length };','add'),blank(),r('Existing callers keep the array response.','muted')];
}
function rightRows(t){
 if(t<6)return [r('> Update the client for pagination.'),blank(),r('Read client.mjs','muted'),r("  return request('/items');"),blank(),r('loadItems() expects an array.','muted')];
 if(t<16){
  const rows=[r('> Update the client for pagination.','muted'),blank(),...claimRows(1),blank(),r('api-agent:','muted'),...message(0,t<9)];
  if(t>=9)rows.push(blank(),r('bassfish.commit_and_done','tool'),...message(1),receipt(1));
  return rows;
 }
 if(t<21){
  const rows=[r('> Update the client for pagination.','muted'),blank(),...claimRows(3),blank(),r('api-agent:','muted'),...message(2,t<18.5)];
  if(t>=18.5)rows.push(blank(),r('bassfish.commit_and_done','tool'),...message(3),receipt(3));
  return rows;
 }
 const rows=[r('Edit client.mjs','tool'),blank(),r("- return request('/items');",'remove'),r("+ return request('/v2/items').items;",'add')];
 if(t>=22.5)rows.push(blank(),r('$ node --test demo.test.mjs'),blank(),r(`tests ${demo.tests.passed}`,'muted'),r(`pass  ${demo.tests.passed}`,'pass'),r(`fail  ${demo.tests.failed}`,'muted'));
 return rows;
}
export function frame(t){
 t=Math.max(0,Math.min(DURATION-.001,t));
 const active=t<6?'left':t<12?'right':t<16?'left':t<21?'right':'both';
 const description=events.find(([a,b])=>t>=a&&t<b)[2];
 const body=pane(0,'api-agent',leftRows(t),active==='left'||active==='both',t)+pane(912,'client-agent',rightRows(t),active==='right'||active==='both',t);
 return svg(VIDEO_WIDTH,VIDEO_HEIGHT,`Bassfish terminal demo. ${description} Scripted agent session using captured real MCP calls.`,body);
}
