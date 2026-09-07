const {chromium}=require(process.env.BASSFISH_PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs/promises');
(async()=>{
 const art=await import('./artwork.mjs');
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1920,height:1080}});
 const failures=[];let samples=0;
 const cases=[['banner',art.overview()],['social',art.overview(1280,640)],['workflow',art.workflow()],['brand',art.brandSheet()]];
 for(let n=0;n<art.DURATION*art.FPS;n++)cases.push([`frame ${n}`,art.frame(n/art.FPS)]);
 for(const [name,source] of cases){
  await page.setContent(`<style>body{margin:0}</style>${source}`);
  const problems=await page.evaluate(()=>{
   const svg=document.querySelector('svg'),bounds=svg.getBoundingClientRect();
   const elements=[...svg.querySelectorAll('text')].filter(e=>!e.closest('g[opacity="0.000"]')).map(e=>({text:e.textContent,r:e.getBoundingClientRect()}));
   const issues=[];
   for(const e of elements)if(e.r.left<-.5||e.r.top<-.5||e.r.right>bounds.right+.5||e.r.bottom>bounds.bottom+.5)issues.push(`Outside canvas: ${e.text}`);
   for(let i=0;i<elements.length;i++)for(let j=i+1;j<elements.length;j++){
    const a=elements[i],b=elements[j];
    if(Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1)issues.push(`Text overlap: ${a.text} / ${b.text}`);
   }
   return issues;
  });
  if(problems.length)failures.push({name,problems});samples++;
 }
 const root=require('node:path').resolve(__dirname,'..');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto('file://'+root+'/index.html');await page.screenshot({path:root+'/qa/gallery-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow)failures.push({name:'mobile gallery',problems:['Horizontal overflow']});
 await page.screenshot({path:root+'/qa/gallery-mobile.png',fullPage:true});
 await fs.writeFile(root+'/qa/layout-checks.json',JSON.stringify({samples,failures,mobileWidth:390},null,2));
 console.log(JSON.stringify({samples,failures},null,2));
 await browser.close();if(failures.length)process.exitCode=1;
})();
