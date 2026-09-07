import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {C,workflowGeometry,DURATION,FPS,GIF_DURATION,VIDEO_WIDTH,VIDEO_HEIGHT,GIF_WIDTH,GIF_HEIGHT} from './artwork.mjs';
const require=createRequire(import.meta.url);
const sharp=require(process.env.BASSFISH_SHARP_MODULE||'sharp');
const root=fileURLToPath(new URL('../',import.meta.url));
const checks=[];
for(const sub of ['','logo','video'])for(const f of await readdir(path.join(root,sub))){
 if(!f.endsWith('.svg'))continue;
 const stem=path.join(root,sub,f.slice(0,-4)),source=await readFile(stem+'.svg','utf8');
 const [,w,h]=source.match(/width="(\d+)" height="(\d+)"/);
 const m=await sharp(stem+'.png').metadata();
 assert.equal(m.width,Number(w));assert.equal(m.height,Number(h));
 assert(source.includes('<title'));assert(!source.includes('NaN'));assert(!source.includes('undefined'));
 // Compare exported PNG against a fresh render, catching stale exports.
 const [actual,expected]=await Promise.all([sharp(stem+'.png').raw().toBuffer(),sharp(Buffer.from(source)).raw().toBuffer()]);
 assert(actual.equals(expected),`${f}: stale PNG`);
 checks.push(`${sub?sub+'/':''}${f}: dimensions and PNG/source parity passed`);
}
const wf=await readFile(path.join(root,'workflow.svg'),'utf8');
const connectors=[...wf.matchAll(/data-connector="([\d,.]+)"/g)].map(m=>m[1].split(',').map(Number));
const g=workflowGeometry;
assert.equal(connectors.length,2);
for(let i=0;i<2;i++)assert.deepEqual(connectors[i],[g.centers[i]+g.radius,g.y,g.centers[i+1]-g.radius,g.y]);
checks.push('Workflow: both arrows join the circular nodes on one horizontal axis');
function lum(hex){return hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
for(const name of ['ink','mint','muted']){const contrast=(lum(C.white)+.05)/(lum(C[name])+.05);assert(contrast>=4.5);checks.push(`${name} on canvas: ${contrast.toFixed(2)}:1 text contrast`);}
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path.join(root,'video/bassfish-preview.mp4')],{encoding:'utf8'}));
const stream=probe.streams.find(s=>s.codec_type==='video');
assert.equal(stream.width,VIDEO_WIDTH);assert.equal(stream.height,VIDEO_HEIGHT);assert.equal(stream.codec_name,'h264');assert.equal(stream.pix_fmt,'yuv420p');assert.equal(stream.nb_frames,String(DURATION*FPS));assert(Math.abs(Number(probe.format.duration)-DURATION)<.05);
checks.push(`Video: ${VIDEO_WIDTH} × ${VIDEO_HEIGHT}, H.264 yuv420p, ${DURATION*FPS} frames, ${DURATION} seconds`);
const gif=await sharp(path.join(root,'video/chat-exchange.gif'),{animated:true}).metadata();
assert.equal(gif.width,GIF_WIDTH);assert.equal(gif.pageHeight,GIF_HEIGHT);assert.equal(gif.loop,0);assert.equal(gif.pages,GIF_DURATION*12);assert(Math.abs(gif.delay.reduce((a,b)=>a+b,0)-GIF_DURATION*1000)<50);
checks.push(`GIF: ${GIF_WIDTH} × ${GIF_HEIGHT}, 96 frames, 8 seconds, infinite loop`);
await writeFile(path.join(root,'qa/export-checks.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks},null,2)+'\n');
console.log(checks.join('\n'));
