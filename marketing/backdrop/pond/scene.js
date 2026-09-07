import * as THREE from '../vendor/three.module.min.js';
import { buildHabitat } from './habitat.js';
import { buildBass } from './bass.js';
import { DEPTH_SCALE, layoutZ } from './dimensions.js';

const clamp=THREE.MathUtils.clamp;

export function mountPond(container,options={}){
  // Stable placement of the remaining stones and solid habitat details.
  let seed=1033157065;
  const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion=motion.matches,paused=options.paused??reducedMotion,disposed=false,visible=!document.hidden,texturesReady=false;
  let time=5,previous=0,raf=0,signalAge=20,frames=0;
  let yaw=.72,elevation=.56,targetYaw=.72,targetElevation=.56,width=1,height=1;
  let story=null,storyProgress=0;
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:Boolean(options.createStory),powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.65));renderer.setClearColor(0xffffff,options.createStory?0:1);
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.98;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
  renderer.localClippingEnabled=true;
  renderer.domElement.setAttribute('aria-hidden','true');renderer.domElement.style.opacity='0';container.appendChild(renderer.domElement);
  const scene=new THREE.Scene();
  const camera=new THREE.OrthographicCamera(-10,10,8,-8,.1,100);
  const world=new THREE.Group();scene.add(world);
  const light=new THREE.DirectionalLight(0xfff7e8,2.5);light.position.set(-4,14,6);light.castShadow=true;
  light.shadow.mapSize.set(2048,2048);Object.assign(light.shadow.camera,{left:-10,right:10,top:10,bottom:-10,near:1,far:35});light.shadow.bias=-.0004;light.shadow.normalBias=.025;light.shadow.radius=4;scene.add(light);
  scene.add(new THREE.HemisphereLight(0xf1f7f0,0x877454,1.35));
  const fill=new THREE.DirectionalLight(0xcbe5df,.65);fill.position.set(7,4,-5);scene.add(fill);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false}));ground.rotation.x=-Math.PI/2;ground.position.y=-5.525;scene.add(ground);
  // The story's HTML headings sit behind the transparent canvas and its silhouette.
  ground.visible=!options.createStory;
  const shadow=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({opacity:.10}));shadow.rotation.x=-Math.PI/2;shadow.position.y=-5.520;shadow.receiveShadow=true;scene.add(shadow);
  const timeUniform={value:time};
  const materialCache=new Map();
  const material=(color,roughness=.8,metalness=0)=>{
    const key=`${color}/${roughness}/${metalness}`;
    if(!materialCache.has(key))materialCache.set(key,new THREE.MeshStandardMaterial({color,roughness,metalness}));
    return materialCache.get(key);
  };
  function mesh(geometry,mat,position=[0,0,0],parent=world,shadow=true){
    const m=new THREE.Mesh(geometry,mat);m.position.set(...position);m.castShadow=shadow;m.receiveShadow=true;parent.add(m);return m;
  }
  const habitat=buildHabitat({world,mesh,material,rand,timeUniform});

  const bass=buildBass({world,timeUniform});
  const fishes=bass.fishes;

  // Batch fixed meshes by material. Fish, water, and interactive parts stay separate.
  const retiredGeometries=new Set(),batches=new Map();world.updateMatrixWorld(true);
  world.traverse(object=>{
    if(!object.isMesh||!object.material.isMeshStandardMaterial||object.material.transparent)return;
    for(let parent=object;parent;parent=parent.parent)if(parent.userData.dynamic)return;
    const key=`${object.material.uuid}/${object.castShadow}/${object.receiveShadow}`;
    if(!batches.has(key))batches.set(key,[]);batches.get(key).push(object);
  });
  for(const objects of batches.values()){
    if(objects.length<2)continue;
    const positions=[],normals=[],uvs=[];
    for(const object of objects){
      const g=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();g.applyMatrix4(object.matrixWorld);
      const p=g.attributes.position,n=g.attributes.normal,uv=g.attributes.uv;
      for(let i=0;i<p.count;i++){positions.push(p.getX(i),p.getY(i),p.getZ(i));normals.push(n.getX(i),n.getY(i),n.getZ(i));uvs.push(uv?.getX(i)??0,uv?.getY(i)??0);}
      g.dispose();retiredGeometries.add(object.geometry);object.removeFromParent();
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    const combined=new THREE.Mesh(g,objects[0].material);combined.castShadow=objects[0].castShadow;combined.receiveShadow=objects[0].receiveShadow;world.add(combined);
  }

  function draw(dt=0){
    const blend=dt?1.-Math.exp(-dt*6):1;
    yaw=THREE.MathUtils.lerp(yaw,targetYaw,blend);elevation=THREE.MathUtils.lerp(elevation,targetElevation,blend);
    const r=21,focusY=-1.5875;
    camera.position.set(Math.sin(yaw)*Math.cos(elevation)*r,Math.sin(elevation)*r+focusY,Math.cos(yaw)*Math.cos(elevation)*r);
    camera.lookAt(0,focusY,0);
    timeUniform.value=time;
    if(!story)fishes.forEach((f,i)=>{
      const a=time*(.10+i*.013)+f.phase;
      let dx,dz;
      if(i===0){
        const along=Math.cos(a)*.8,across=Math.sin(a)*.10;
        f.fish.position.set(1.1+along*.75+across*.66,-1.63+Math.sin(time*.5+f.phase)*.05,layoutZ(2.72-along*.66+across*.75));
        dx=-Math.sin(a)*.8*.75+Math.cos(a)*.10*.66;dz=Math.sin(a)*.8*.66+Math.cos(a)*.10*.75;
      }else{
        f.fish.position.set(3.17+Math.cos(a)*.58,-1.83+Math.sin(time*.5+f.phase)*.05,layoutZ(1.32+Math.sin(a)*.30));
        dx=-Math.sin(a)*.58;dz=Math.cos(a)*.30;
      }
      f.fish.rotation.set(0,Math.atan2(-dz*DEPTH_SCALE,dx),Math.sin(time*.7+f.phase)*.022);
    });
    habitat.update(time,signalAge);
    story?.update({progress:storyProgress,time,width,height,paused});
    renderer.render(scene,camera);frames++;
  }
  function resize(){
    width=Math.max(1,container.clientWidth);height=Math.max(1,container.clientHeight);
    // Give the miniature more white space at every screen size.
    const aspect=width/height,view=(aspect<.8?14.2/aspect:aspect<1.25?16.9:15.5)*1.16;
    camera.left=-view*aspect/2;camera.right=view*aspect/2;camera.top=view/2;camera.bottom=-view/2;camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,options.pixelRatio??1.65,width<700?1.4:1.65));renderer.setSize(width,height,false);draw();
  }
  function tick(now){
    if(disposed)return;const dt=previous?Math.min((now-previous)/1000,.06):0;previous=now;
    if(visible&&(!paused||Math.abs(yaw-targetYaw)>.001||Math.abs(elevation-targetElevation)>.001)){
      if(!paused){time+=dt;signalAge+=dt;}draw(dt);
    }
    raf=requestAnimationFrame(tick);
  }
  let dragging=false,moved=0,lastX=0,lastY=0;
  const onDown=e=>{if(options.createStory||e.button!==0)return;dragging=true;moved=0;lastX=e.clientX;lastY=e.clientY;container.setPointerCapture(e.pointerId);};
  const onMove=e=>{if(!dragging)return;const dx=e.clientX-lastX,dy=e.clientY-lastY;moved+=Math.abs(dx)+Math.abs(dy);lastX=e.clientX;lastY=e.clientY;targetYaw=clamp(targetYaw-dx*.005,.15,1.39);targetElevation=clamp(targetElevation+dy*.004,.25,.88);if(paused)draw();};
  function signal(){signalAge=paused?.5:0;draw();}
  const onUp=e=>{if(!dragging)return;dragging=false;if(container.hasPointerCapture(e.pointerId))container.releasePointerCapture(e.pointerId);if(moved<6)signal();};
  const onCancel=()=>{dragging=false;};
  const onVisibility=()=>{visible=!document.hidden;previous=0;};
  const onMotion=()=>{reducedMotion=motion.matches;if(reducedMotion){paused=true;draw();container.dispatchEvent(new Event('pond:motionchange'));}};
  const onContextLost=e=>{e.preventDefault();paused=true;renderer.domElement.style.opacity='0';container.dispatchEvent(new Event('pond:motionchange'));};
  container.addEventListener('pointerdown',onDown);container.addEventListener('pointermove',onMove);container.addEventListener('pointerup',onUp);container.addEventListener('pointercancel',onCancel);
  document.addEventListener('visibilitychange',onVisibility);motion.addEventListener('change',onMotion);renderer.domElement.addEventListener('webglcontextlost',onContextLost);
  const observer=new ResizeObserver(resize);observer.observe(container);resize();raf=requestAnimationFrame(tick);
  return {
    ready:Promise.all([habitat.ready,bass.ready]).then(()=>{if(!disposed){texturesReady=true;habitat.update(time,signalAge);story=options.createStory?.({scene,world,camera,fishes,timeUniform,renderer,light});draw();renderer.domElement.style.opacity='1';}}),
    get paused(){return paused;},get reducedMotion(){return reducedMotion;},
    setPaused(value){paused=Boolean(value);previous=0;draw();},signal,
    setStoryProgress(value){storyProgress=clamp(value,0,5.8);if(!disposed)draw();},
    resetView(){targetYaw=.72;targetElevation=.56;draw();},
    getStats(){return {frames,time,signalAge,paused,width,height,yaw,elevation,texturesReady,...habitat.getStats(),...bass.getStats(),...story?.getStats(),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,threeRevision:THREE.REVISION};},
    dispose(){
      if(disposed)return;disposed=true;cancelAnimationFrame(raf);observer.disconnect();
      container.removeEventListener('pointerdown',onDown);container.removeEventListener('pointermove',onMove);container.removeEventListener('pointerup',onUp);container.removeEventListener('pointercancel',onCancel);document.removeEventListener('visibilitychange',onVisibility);motion.removeEventListener('change',onMotion);renderer.domElement.removeEventListener('webglcontextlost',onContextLost);
      story?.dispose();const geometries=new Set(retiredGeometries),materials=new Set(materialCache.values());scene.traverse(obj=>{if(obj.geometry)geometries.add(obj.geometry);if(obj.material)materials.add(obj.material);});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());habitat.dispose();bass.dispose();light.shadow.map?.dispose();renderer.dispose();renderer.domElement.remove();
    },
  };
}
