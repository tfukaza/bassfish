const {chromium}=require(process.env.BASSFISH_PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const base=process.env.BASSFISH_SITE_TEST_URL||'http://127.0.0.1:8081/bassfish/';
 const output=require('node:path').resolve(__dirname,'../qa/features');await fs.mkdir(output,{recursive:true});
 const checks=[];const check=(name,value)=>{assert(value,name);checks.push(name);};
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForSelector('.workflow-demo[data-phase]');
 const demo=page.locator('[data-demo="team"]');
 const elapsed=()=>page.locator('.workflow-demo').evaluateAll(es=>es.map(e=>Number(e.dataset.elapsed)));
 await page.waitForTimeout(250);check('Offscreen demos do not start',(await elapsed()).every(t=>t===0));
 await demo.scrollIntoViewIfNeeded();await page.waitForTimeout(600);
 check('One substantially visible demo advances',(await elapsed()).filter(t=>t>0).length===1);
 await demo.locator('[data-demo-toggle]').focus();await page.keyboard.press('Enter');const paused=await elapsed();await page.waitForTimeout(250);
 check('Keyboard Pause holds playback',JSON.stringify(paused)===JSON.stringify(await elapsed()));
 await page.keyboard.press('Enter');await page.waitForTimeout(250);check('Keyboard Resume advances playback',(await elapsed())[0]>paused[0]);
 await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.waitForTimeout(200);const off=await elapsed();await page.waitForTimeout(250);check('Leaving the viewport suspends playback',JSON.stringify(off)===JSON.stringify(await elapsed()));
 await demo.scrollIntoViewIfNeeded();
 // Simulate the browser visibility event deterministically in headless Chromium.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});const hidden=await elapsed();await page.waitForTimeout(250);
 check('Hidden tabs suspend all demos',JSON.stringify(hidden)===JSON.stringify(await elapsed()));
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>document.querySelector('[data-demo="team"]').dataset.phase==='1');
 check('Client joins from Claude Code',await demo.locator('.demo-host').nth(1).isVisible());
 await page.waitForFunction(()=>Number(document.querySelector('[data-demo="team"]').dataset.elapsed)>7800);
 check('Question and response appear',await demo.locator('.demo-message:visible').count()===2);
 await page.waitForFunction(()=>document.querySelector('[data-demo="team"]').dataset.complete==='true');
 check('Disconnected session retains its conversation',(await demo.innerText()).includes('Session closed')&&await demo.locator('.demo-message:visible').count()===2);
 await page.waitForTimeout(250);check('Completed demo holds',(await elapsed())[0]===12000);
 await demo.locator('[data-demo-replay]').focus();await page.keyboard.press('Enter');check('Keyboard Replay resets the example',(await elapsed())[0]<1000);
 for(const name of ['mentions','notes']){
  const d=page.locator(`[data-demo="${name}"]`);await d.scrollIntoViewIfNeeded();
  await page.waitForFunction(name=>document.querySelector(`[data-demo="${name}"]`).dataset.phase==='1',name);
  check(`${name} shows its intermediate action`,(await d.innerText()).includes(name==='notes'?'client-agent is waiting':'Direct mention from api-agent'));
  await d.screenshot({path:`${output}/${name}-intermediate.png`});
  await page.waitForFunction(name=>document.querySelector(`[data-demo="${name}"]`).dataset.complete==='true',name);
  check(`${name} reaches its final state`,(await d.innerText()).includes(name==='notes'?'Hide Next when nextCursor is null':'api-agent · client-agent'));
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>[...document.querySelectorAll('.workflow-demo')].every(e=>e.dataset.complete==='true'&&e.querySelector('.demo-controls').hidden));
 check('Reduced motion shows complete examples and no playback controls',await page.locator('.workflow-demo').evaluateAll(es=>es.every(e=>e.dataset.complete==='true'&&e.querySelector('.demo-controls').hidden)));
 for(const width of [1440,900,800,390,320]){
  await page.setViewportSize({width,height:1000});
  check(`No horizontal overflow at ${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check(`Readable transcripts at ${width}`,await page.locator('.demo-animation').evaluateAll(es=>es.every(e=>[...e.querySelectorAll('p,span,small,strong,b')].filter(x=>x.getClientRects().length).every(x=>parseFloat(getComputedStyle(x).fontSize)>=12))));
  check(`Demo content fits at ${width}`,await page.locator('.demo-animation').evaluateAll(es=>es.every(e=>e.scrollHeight<=e.clientHeight)));
  check(`Correct section layout at ${width}`,await page.locator('.feature-section').evaluateAll((es,w)=>es.every(e=>{const c=e.querySelector('.feature-copy').getBoundingClientRect(),d=e.querySelector('.workflow-demo').getBoundingClientRect();return w<900?c.bottom<=d.top:c.right<=d.left||d.right<=c.left;}),width));
  await page.locator('#features').screenshot({path:`${output}/${width}.png`});
 }
 const noJS=await browser.newPage({javaScriptEnabled:false,viewport:{width:390,height:844}});await noJS.goto(base);
 check('No-JavaScript has all three complete examples',await noJS.locator('.feature-section').count()===3&&await noJS.locator('.demo-message:visible').count()===5&&(await noJS.locator('[data-demo="notes"]').innerText()).includes('Hide Next when nextCursor is null'));
 check('No-JavaScript exposes action sequences without inactive controls',await noJS.locator('.demo-steps li').count()===12&&await noJS.locator('.demo-controls:visible').count()===0);
 check('Animated transcripts do not announce updates',await page.locator('.demo-animation[aria-hidden="true"]').count()===3&&await page.locator('.workflow-demo [aria-live]').count()===0);
 check('No page errors',errors.length===0);await fs.writeFile(`${output}/checks.json`,JSON.stringify({base,checks,errors},null,2));console.log(`Passed ${checks.length} feature checks.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
