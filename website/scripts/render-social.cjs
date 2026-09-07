// Render the current Three.js scene and Geist typography into the committed share image.
// Run against a built, running preview; this is separate from the static Pages build.
const {chromium}=require(process.env.BASSFISH_PLAYWRIGHT_MODULE||'playwright');
const path=require('node:path');

(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1,reducedMotion:'reduce'});
    await page.goto(process.env.BASSFISH_SITE_TEST_URL||'http://127.0.0.1:8081/bassfish/');
    await page.waitForFunction(()=>window.bassfishStory,null,{timeout:30000});
    await page.evaluate(async()=>{
      await document.fonts.ready;
      const tagline=document.querySelector('.landing-title p').textContent;
      const card=document.createElement('div');card.className='share-brand';
      card.innerHTML='<div class="share-wordmark"><img src="./assets/icon.svg" alt=""><span>bassfish</span></div><p></p><span class="share-address">tfukaza.github.io/bassfish</span>';
      card.querySelector('p').textContent=tagline;
      document.querySelector('.story-stage').append(card);
      window.bassfishStory.setPaused(true);
    });
    await page.addStyleTag({content:`
      html{scroll-behavior:auto}body{overflow:hidden}
      .landing-title,.chapter-heading,.story-navigation,.bubble-layer,.terminal-layer{display:none!important}
      #pond{left:480px;top:-100px;right:auto;bottom:auto;width:720px;height:760px}
      .share-brand{position:absolute;inset:0;z-index:4;pointer-events:none}
      .share-wordmark{position:absolute;left:56px;top:147px;display:flex;align-items:center;gap:10px}
      .share-wordmark img{width:76px;height:76px}
      .share-wordmark span{font:500 86px/1 Geist,Arial,sans-serif;letter-spacing:-.075em}
      .share-brand>p{position:absolute;left:64px;top:270px;width:450px;font:450 44px/1.15 Geist,Arial,sans-serif;letter-spacing:-.04em;text-wrap:balance}
      .share-address{position:absolute;left:64px;bottom:48px;font:13px/1 'Geist Mono',monospace;color:#656b61}
    `});
    await page.waitForFunction(()=>window.bassfishStory.getStats().width===720);
    await page.evaluate(()=>window.bassfishStory.setStoryProgress(4.8));
    await page.waitForFunction(()=>window.bassfishStory.getStats().progress===4.8);
    await page.locator('.share-wordmark img').evaluate(img=>img.decode());
    const output=path.resolve(__dirname,'../assets/bassfish-team-social-v1.jpg');
    await page.screenshot({path:output,type:'jpeg',quality:94,animations:'disabled'});
    console.log(`Rendered ${output} (1200 × 630)`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
