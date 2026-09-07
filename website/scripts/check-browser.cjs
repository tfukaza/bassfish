const {chromium}=require(process.env.BASSFISH_PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
  const base=process.env.BASSFISH_SITE_TEST_URL||'http://127.0.0.1:8081/bassfish/';
  const output=path.resolve(__dirname,'../qa/story');await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage(),checks=[],errors=[];
  const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
  const ready=p=>p.waitForFunction(()=>document.querySelector('#pond').dataset.ready==='true',null,{timeout:30000});
  const stats=()=>page.evaluate(()=>window.bassfishStory.getStats());
  const progress=async p=>{
    await page.evaluate(p=>{const story=document.querySelector('#story');scrollTo({top:story.offsetTop+(story.offsetHeight-innerHeight)*p/5.6,behavior:'instant'});},p);
    await page.waitForFunction(p=>Math.abs(window.bassfishStory.getStats().progress-p)<.006,p);
    await page.waitForTimeout(260);
  };
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
  try{
    await page.goto(base);await ready(page);
    check('Landing shows one pond and one agent',(await stats()).ponds===1&&(await stats()).hiddenAgents===0&&!(await stats()).carrier);
    check('Title is visible HTML above the pond',await page.locator('.landing-title').isVisible()&&await page.locator('#site-title').textContent()==='bassfish');
    check('Geist fonts are loaded locally',await page.evaluate(()=>document.fonts.check('16px Geist')&&document.fonts.check('16px "Geist Mono"')&&getComputedStyle(document.body).fontFamily.startsWith('Geist')));
    check('Hero typography is substantially larger',await page.locator('#site-title').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=120));
    check('Transparent canvas lets HTML scroll behind the pond',await page.locator('#pond canvas').evaluate(e=>e.getContext('webgl2').getContextAttributes().alpha));
    check('Full story is available to assistive technology',await page.locator('.story-chapters h2').count()===5&&await page.locator('.skip-link').getAttribute('href')==='#install');
    await page.getByRole('button',{name:'Pause motion',exact:true}).click();
    const frozen=(await stats()).time;await page.waitForTimeout(200);
    check('Pause stops ambient animation',(await stats()).time===frozen);
    await progress(.66);const entering=await stats();
    await page.screenshot({path:path.join(output,'1440-text-entering.png')});
    await progress(1.1);
    check('Headings rise from behind the pond',entering.textY>200&&(await stats()).textY<1);
    check('The pond settles lower after the hero',(await stats()).sceneDrop>.10);
    check('The single fish surfaces',(await stats()).leadFishY>0);
    check('Agent status appears beside the fish',await page.locator('.fish-bubble.visible').count()===1&&(await page.locator('.fish-bubble.visible').textContent()).includes('question'));
    check('Chapter heading is flat HTML',(await page.locator('#chapter-title').textContent()).includes('One agent')&&await page.locator('.chapter-heading').isVisible());
    await progress(2.12);
    check('Three hidden agents join beneath the visible agent',(await stats()).hiddenAgents===3&&(await stats()).ponds===1);
    check('Each submerged agent has a doing something bubble',(await page.locator('.fish-bubble.visible').allTextContents()).length===3&&(await page.locator('.fish-bubble.visible').allTextContents()).every(text=>text==='doing something'));
    check('The small third line of story text is removed',await page.locator('#repo-context').count()===0);
    await progress(2.9);const turning=(await stats()).pondPoses.map(p=>p.rotation);
    await progress(3.35);const separated=await stats();
    check('Three other ponds rotate into existence',separated.ponds===4&&Math.abs(turning[1]-separated.pondPoses[1].rotation)>.05);
    check('Ponds face outward at quarter turns',separated.pondPoses.every((pose,i)=>Math.abs(pose.rotation-[0,-Math.PI/2,Math.PI,Math.PI/2][i])<.001));
    check('The original pond is at the bottom',separated.pondPoses.slice(1).every(p=>p.y<separated.pondPoses[0].y));
    check('Separate ponds have no connecting rig yet',!separated.carrier&&separated.microphones===0);
    const flight=[];
    for(const p of [3.63,3.80,3.99]){await progress(p);flight.push(await stats());await page.screenshot({path:path.join(output,`flight-${p}.png`)});}
    check('The arriving bass follows a curved swimming path',flight[1].carrierPosition[2]>flight[0].carrierPosition[2]+2&&flight[1].carrierPosition[2]>flight[2].carrierPosition[2]+2);
    check('The bass turns to follow each bend',Math.abs(flight[0].carrierForward[2]-flight[1].carrierForward[2])>.2);
    await progress(4.35);check('The larger bass flies in above the ponds',(await stats()).carrier&&!(await stats()).connected);
    check('The large bass faces down and right toward the camera',(await stats()).carrierNose.x>(await stats()).carrierTail.x&&(await stats()).carrierNose.y>(await stats()).carrierTail.y);
    await progress(5.15);check('Four microphones connect the agents',(await stats()).microphones===4&&(await stats()).connected);
    check('The API and client exchange messages',await page.locator('.fish-bubble.visible').count()===2&&(await page.locator('.fish-bubble.visible').allTextContents()).some(text=>text.includes('Got it')));
    check('Geometry and texture sharing keep the scene bounded',(await stats()).drawCalls<450&&(await stats()).triangles<200000);
    await progress(5.4);check('The conversation continues with tests and review',(await page.locator('.fish-bubble.visible').allTextContents()).some(text=>text.includes('tests pass')));
    const orbit=(await stats()).orbit;
    await page.getByRole('button',{name:'Play motion',exact:true}).click();
    const swim=(await stats()).leadFishPosition;
    await page.waitForTimeout(400);
    const animated=await stats();
    check('Surface fish swim around a circular path',Math.hypot(animated.leadFishPosition[0]-swim[0],animated.leadFishPosition[2]-swim[2])>.04&&Math.abs(Math.hypot(animated.leadFishPosition[0]-1.4,animated.leadFishPosition[2]-2)-.85)<.001);
    check('The connected scene keeps rotating',animated.orbit>orbit+.01);
    await page.getByRole('button',{name:'Pause motion',exact:true}).click();
    await progress(0);check('Reverse scrolling restores the single-pond landing',(await stats()).ponds===1&&(await stats()).hiddenAgents===0&&!(await stats()).carrier);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:width===1440?1000:844});
      for(const [name,p] of [['landing',0],['single',1.1],['hidden',2.12],['separate',3.35],['arrival',4.35],['connected',5.15]]){
        await progress(p);await page.screenshot({path:path.join(output,`${width}-${name}.png`)});
        check(`${name} fits at ${width}px`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.fish-bubble.visible')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<innerHeight;})));
      }
    }
    for(const width of [320,768,1024,1920]){
      await page.setViewportSize({width,height:900});await progress(5.15);
      check(`No page overflow at ${width}px`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.story-controls a[href="#install"]').click();
    check('Skip to install moves focus to the installation section',await page.evaluate(()=>document.activeElement.id==='install'&&Math.abs(document.querySelector('#install').getBoundingClientRect().top)<45));
    check('Installation is ordered handoff, install, connect, skills',JSON.stringify(await page.locator('.step-heading h2').allTextContents())===JSON.stringify(['Hand this to your agent.','Install Bassfish','Connect each agent','Give your agents the skills']));
    check('The handoff is a separate alternative to steps 1–3',await page.locator('.agent-handoff .step-number').count()===0&&await page.locator('.install-steps > li').count()===3&&await page.locator('.install-or').textContent()==='OR');
    check('Detailed documentation links are in the footer',await page.locator('.site-footer a[href="./setup.md"]').count()===1&&await page.locator('#install a').count()===4);
    for(const width of [1440,390]){await page.setViewportSize({width,height:width===1440?1000:844});await page.locator('#install').scrollIntoViewIfNeeded();await page.locator('#install').screenshot({path:path.join(output,`${width}-install.png`)});}
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-copy="skills-code"]').click();
    const skillCommand=await page.evaluate(()=>navigator.clipboard.readText());
    check('Copy skills command includes both skills',skillCommand.includes('--skill use-bassfish --skill manage-bassfish -g')&&skillCommand.startsWith('npx skills add tfukaza/bassfish'));
    await page.locator('[data-copy="install-code"]').click();
    check('Copy installation commands',await page.evaluate(()=>navigator.clipboard.readText())==='npm install -g @bassfish/cli\nbassfish setup\nbassfish --version');
    await page.getByRole('tab',{name:'Claude Code'}).click();await page.locator('#host-claude [data-copy]').click();
    check('Host tabs and copied commands work',(await page.evaluate(()=>navigator.clipboard.readText())).startsWith('claude mcp add --scope user bassfish -- bassfish mcp'));
    await page.getByRole('tab',{name:'Claude Code'}).focus();await page.keyboard.press('ArrowRight');
    check('Host picker supports keyboard navigation',await page.getByRole('tab',{name:'Other MCP hosts'}).getAttribute('aria-selected')==='true');
    await page.keyboard.press('Home');
    await page.locator('[data-copy-url]').click();check('Agent guide link preserves the project path',await page.evaluate(()=>navigator.clipboard.readText())===new URL('setup.md',base).href);
    check('The first conversation is available in the full documentation',(await (await page.request.get(new URL('setup.md',base).href)).text()).includes('## Start a conversation'));
    for(const name of ['setup.md','llms.txt','index.md']){
      const response=await page.request.get(new URL(name,base).href);
      check(`${name} is readable and includes skills`,response.ok()&&/text\//.test(response.headers()['content-type'])&&(await response.text()).includes('use-bassfish'));
    }
    await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base);await ready(page);
    check('Reduced-motion preference starts paused',(await stats()).paused);
    await page.evaluate(()=>{const story=document.querySelector('#story');scrollTo({top:(story.offsetHeight-innerHeight)*3.3/5.6,behavior:'instant'});});
    await page.waitForFunction(()=>window.bassfishStory.getStats().chapter===3);
    check('Reduced motion uses still chapter poses',Math.abs((await stats()).progress-3.25)<.001);
    const still=(await stats()).time;await page.waitForTimeout(180);check('Reduced-motion scene stays still',(await stats()).time===still);
    for(const [name,setup] of [
      ['WebGL unavailable',async p=>p.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:original.call(this,type,...args);};})],
      ['Missing texture',async p=>p.route('**/foliage/cattails-v2.webp',route=>route.abort())],
    ]){
      const fallback=await context.newPage();await setup(fallback);await fallback.goto(base);
      await fallback.waitForFunction(()=>document.querySelector('#pond').dataset.ready==='fallback');
      check(`${name} retains a visible text story and installation`,await fallback.locator('.story-chapters').isVisible()&&await fallback.locator('#install-code').isVisible()&&await fallback.locator('#pond canvas').count()===0);
      await fallback.close();
    }
    const noJS=await browser.newPage({javaScriptEnabled:false});await noJS.goto(base);
    check('No-JavaScript view includes the complete story and host instructions',await noJS.locator('.story-chapters').isVisible()&&await noJS.locator('#host-claude').isVisible()&&await noJS.locator('#host-codex').isVisible());
    check('No-JavaScript view has no inactive copy controls',await noJS.locator('[data-copy-url]').isHidden());await noJS.close();
    const preview=await context.newPage();await preview.goto(new URL('backdrop/pond/',base).href);await preview.waitForFunction(()=>!!window.bassfishPond);
    check('The standalone pond remains available',await preview.evaluate(()=>window.bassfishPond.getStats().texturedBass===2));
    await preview.getByRole('button',{name:'Pause animation',exact:true}).click();await preview.getByRole('button',{name:'Reset view',exact:true}).click();
    check('Standalone pond controls still work',await preview.evaluate(()=>window.bassfishPond.paused&&window.bassfishPond.getStats().yaw===.72));await preview.close();
    await page.evaluate(()=>window.bassfishStory.dispose());const frames=(await stats()).frames;await page.waitForTimeout(100);
    check('Disposal removes the canvas and stops drawing',await page.locator('#pond canvas').count()===0&&(await stats()).frames===frames);
    check('No JavaScript, shader, or resource errors',errors.length===0);
    await fs.writeFile(path.join(output,'checks.json'),JSON.stringify({base,checks,errors},null,2));console.log(JSON.stringify({base,checks,errors},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
