import * as THREE from './backdrop/vendor/three.module.min.js';
import { POND_SIDE } from './backdrop/pond/dimensions.js';

const V = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const ease = (a,b,x) => { const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };

export const chapters = [
  { title:'Bassfish', body:'headless chat and notes for agent teams' },
  { title:'One agent is easy to follow.', body:'It works in your repo and surfaces when it needs you.' },
  { title:'But when you need multiple agents…', body:'Many agent frameworks hide the subagents below the surface, so it’s hard to monitor what’s happening.' },
  { title:'Coordinating multiple agents by hand is hard.', body:'' },
  { title:'Bassfish gives agents a way to communicate with you and with each other.', body:'' },
  { title:'Now you have a team of agents with full visibility into what they’re doing.', body:'' },
  { title:'Your team. In plain sight.', body:'' },
];
const chapterStarts=[0,.55,1.62,2.62,3.65,4.8,5.6,8.4];

// This extends the existing pond, sharing its texture maps and batched geometry.
export function createPondStory(onFrame) {
  return ({scene,world,camera,fishes,timeUniform,renderer,light,shadow}) => {
    const pods=[], hiddenFish=[], arms=[], replacedMaterials=new Set();
    let lastProgress=-1, lastChapter=-1, lastViewport='', state={}, previousTime=0, orbitTime=0;
    const template=world.clone(true);
    template.children.filter(object=>object.name==='textured-bass').forEach(object=>object.removeFromParent());
    fishes[1].fish.visible=false;

    function copyMaterial(material) {
      const copy=material.clone();
      copy.onBeforeCompile=material.onBeforeCompile;
      copy.customProgramCacheKey=material.customProgramCacheKey;
      if(copy.uniforms?.uTime)copy.uniforms.uTime=timeUniform;
      return copy;
    }
    function preparePod(group,index) {
      const inverse={value:new THREE.Matrix4()}, materials=new Map(), clipping=[];
      group.traverse(object=>{
        if(!object.material)return;
        const original=object.material;
        replacedMaterials.add(original);
        if(!materials.has(original)) {
          const mat=copyMaterial(original);
          if(original.clippingPlanes?.length) {
            mat.clippingPlanes=original.clippingPlanes.map(plane=>plane.clone());
            clipping.push({original:original.clippingPlanes.map(plane=>plane.clone()),planes:mat.clippingPlanes});
          }
          // The soil shader's coordinates belong to each miniature, not to the whole stage.
          if(original.map?.image?.src?.includes('soil-albedo')) {
            const compile=original.onBeforeCompile;
            mat.onBeforeCompile=shader=>{
              compile(shader);shader.uniforms.uPondInverse=inverse;
              shader.vertexShader='uniform mat4 uPondInverse;\n'+shader.vertexShader.replace('(modelMatrix*vec4(position,1.)).xyz','(uPondInverse*modelMatrix*vec4(position,1.)).xyz');
            };
            mat.customProgramCacheKey=()=> 'story-local-soil';
          }
          materials.set(original,mat);
        }
        object.material=materials.get(original);
      });
      const fish=index===0?fishes[0].fish:fishes[0].fish.clone(true);
      if(index!==0)group.add(fish);
      fish.scale.setScalar(1.06);
      pods.push({group,fish,inverse,clipping,materials:[...materials.values()]});
    }
    preparePod(world,0);
    for(let i=1;i<4;i++) { const group=template.clone(true);scene.add(group);preparePod(group,i); }
    for(let i=0;i<3;i++) {
      const fish=fishes[0].fish.clone(true), materials=new Map();
      fish.traverse(object=>{
        if(!object.material)return;
        if(!materials.has(object.material)) {
          const mat=copyMaterial(object.material);mat.color.set(0x336c65);materials.set(object.material,mat);
        }
        object.material=materials.get(object.material);
      });
      fish.scale.setScalar(.66+i*.07);world.add(fish);hiddenFish.push(fish);
    }

    const metal=new THREE.MeshStandardMaterial({color:0x718279,roughness:.38,metalness:.75});
    const dark=new THREE.MeshStandardMaterial({color:0x2c433c,roughness:.55,metalness:.5});
    const brass=new THREE.MeshStandardMaterial({color:0xc3ac72,roughness:.4,metalness:.65});
    const lit=new THREE.MeshBasicMaterial({color:0xbadd95,toneMapped:false});
    const carrier=new THREE.Group();scene.add(carrier);
    const giant=fishes[0].fish.clone(true);giant.position.set(0,0,0);giant.scale.setScalar(3.5);giant.rotation.set(0,0,0);carrier.add(giant);
    const flight=new THREE.CubicBezierCurve3(V(-31,18,-7),V(-21,15,15),V(-8,12.5,-2.5),V(0,12.5,0));
    const flightBasis=new THREE.Matrix4(), harness=[];
    function item(geometry,material,parent=scene) { const mesh=new THREE.Mesh(geometry,material);parent.add(mesh);return mesh; }
    // Fit each strap to the body's oval cross-section. Fish, straps, and mounts share one frame.
    for(const [x,height,depth] of [[-1.75,1.37,.86],[1.3,1.36,.98]]) {
      const root=new THREE.Group();root.position.x=x;carrier.add(root);
      const oval=new THREE.Curve();
      oval.getPoint=(t,target=V())=>target.set(0,Math.cos(t*Math.PI*2)*height,Math.sin(t*Math.PI*2)*depth);
      item(new THREE.TubeGeometry(oval,64,.055,8,true),brass,root);
      const mount=item(new THREE.BoxGeometry(.40,.22,depth*2+.30),dark,root);mount.position.y=-height+.10;
      harness.push({root,x,height,depth});
    }
    const jointGeo=new THREE.SphereGeometry(.19,12,8), rodGeo=new THREE.CylinderGeometry(1,1,1,10);
    const Y=V(0,1,0);
    function segment(mesh,a,b,radius) { const delta=b.clone().sub(a);mesh.position.copy(a).add(b).multiplyScalar(.5);mesh.scale.set(radius,Math.max(.001,delta.length()),radius);mesh.quaternion.setFromUnitVectors(Y,delta.normalize()); }
    for(let i=0;i<4;i++) {
      const root=new THREE.Group();scene.add(root);
      const upper=item(rodGeo,metal,root), lower=item(rodGeo,brass,root), cable=item(rodGeo,dark,root);
      const joints=[item(jointGeo,brass,root),item(jointGeo,dark,root),item(jointGeo,brass,root)];
      const mic=new THREE.Group();root.add(mic);
      item(new THREE.CylinderGeometry(.22,.19,.65,16),dark,mic);
      for(let j=0;j<5;j++) {const ring=item(new THREE.TorusGeometry(.211,.017,5,16),metal,mic);ring.rotation.x=Math.PI/2;ring.position.y=-.23+j*.10;}
      const tip=item(new THREE.SphereGeometry(.19,12,8),metal,mic);tip.position.y=-.31;tip.scale.y=.5;
      const lamp=item(new THREE.TorusGeometry(.225,.035,6,20),lit,mic);lamp.rotation.x=Math.PI/2;lamp.position.y=.25;
      const ripple=item(new THREE.RingGeometry(.55,.59,40),new THREE.MeshBasicMaterial({color:0xbbddb0,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false}),root);ripple.rotation.x=-Math.PI/2;ripple.renderOrder=9;
      const packet=item(new THREE.SphereGeometry(.105,8,6),lit,root);
      arms.push({root,upper,lower,cable,joints,mic,lamp,ripple,packet});
    }
    light.shadow.camera.left=-24;light.shadow.camera.right=24;light.shadow.camera.top=24;light.shadow.camera.bottom=-24;light.shadow.camera.far=65;light.shadow.camera.updateProjectionMatrix();
    const centers=[V(6.2,0,6.2),V(-6.2,0,6.2),V(-6.2,0,-6.2),V(6.2,0,-6.2)];
    const rotations=[0,-Math.PI/2,Math.PI,Math.PI/2];
    const projected=point=> { const p=point.clone().project(camera);return {x:(p.x+1)*.5,y:(1-p.y)*.5}; };

    return {
      update({progress:p,time,width,height,paused}) {
        const overhead=ease(5.6,6.45,p), morph=ease(6.7,7.6,p), retire=ease(5.6,6.25,p);
        const separate=ease(2.45,3.25,p), arrive=ease(3.5,4.12,p), extend=ease(3.95,4.65,p)*(1-retire), connect=ease(4.5,4.95,p)*(1-retire);
        const chapter=p<.55?0:p<1.62?1:p<2.62?2:p<3.65?3:p<4.8?4:p<5.6?5:6;
        shadow.material.opacity=.10*(1-overhead);
        const aspect=width/height, narrow=aspect<.85;
        const settle=ease(.25,1.0,p), gridSize=Math.min(width*.84,height*.59,720);
        const gridView=(12.4+POND_SIDE+.42)*height/gridSize;
        const view=mix(mix(narrow?17.5/aspect:mix(26,25,settle),narrow?37.5/aspect:44,separate),gridView,overhead);
        const sceneDrop=mix(narrow?settle*.12:mix(.045,.105,settle),.06,overhead);
        camera.left=-view*aspect/2;camera.right=view*aspect/2;camera.top=view*(.5+sceneDrop);camera.bottom=view*(-.5+sceneDrop);camera.updateProjectionMatrix();
        // Orbit the camera so the entire connected scene turns together, including the rig.
        const dt=previousTime?clamp(time-previousTime,0,.1):0;previousTime=time;
        if(chapter===5)orbitTime+=dt;else if(chapter<5)orbitTime=0;
        const orbit=ease(4.8,5.6,p)*Math.PI*2+orbitTime*.14;
        // Preserve the incoming orbit, then take the shortest turn to the fixed overhead frame.
        const incomingYaw=.72+orbit, yaw=incomingYaw-Math.atan2(Math.sin(incomingYaw),Math.cos(incomingYaw))*overhead;
        const elevation=mix(mix(.56,.66,separate),Math.PI/2,overhead), focus=V(0,mix(mix(-2.1,-.6,separate),0,overhead),0);
        camera.up.set(0,1,0);
        camera.position.set(Math.sin(yaw)*Math.cos(elevation)*36,Math.sin(elevation)*36+focus.y,Math.cos(yaw)*Math.cos(elevation)*36);
        if(overhead===1){camera.position.set(0,36,0);camera.up.set(0,0,-1);}
        camera.lookAt(focus);
        camera.updateMatrixWorld();
        const bubbles=[];
        for(let i=0;i<4;i++) {
          const pod=pods[i], reveal=i===0?1:ease(2.55+i*.10,3.05+i*.10,p);
          pod.group.visible=reveal>.001;
          pod.group.position.copy(centers[i]).multiplyScalar(separate);
          pod.group.position.y=i===0?0:-7*(1-reveal);
          pod.group.scale.setScalar(i===0?1:Math.max(.001,reveal));
          pod.group.rotation.y=i===0?0:rotations[i]-(1-reveal)*Math.PI/2;
          const rise=ease(.55,.98,p), bob=Math.sin(time*1.4+i)*.06, angle=time*.36+i*Math.PI/2;
          pod.fish.position.set(1.4+Math.cos(angle)*.85,mix(-1.55,.15,rise)+bob,mix(3.55,2.0+Math.sin(angle)*.85,rise));
          pod.fish.rotation.set(0,Math.atan2(-Math.cos(angle),-Math.sin(angle)),Math.sin(time*.7+i)*.035);
          pod.group.updateMatrixWorld(true);pod.inverse.value.copy(pod.group.matrixWorld).invert();
          for(const record of pod.clipping)record.planes.forEach((plane,j)=>plane.copy(record.original[j]).applyMatrix4(pod.group.matrixWorld));
          const point=pod.fish.getWorldPosition(V()).add(V(.45,chapter===5?2.25:.65,.15));
          let text='',visible=false;
          if(chapter===1&&i===0) {text=['Editing api.ts…','I have a question.','Please approve this change.'][Math.min(2,Math.floor((p-.55)/1.07*3))];visible=true;}
          if(chapter===3) {text=['Editing the endpoint…','What’s the response shape?','Waiting for the API…','Which version do I review?'][i];visible=(i===0||i===2);}
          if(chapter===5) {
            const exchange=Math.min(1,Math.floor((p-4.8)/.48));
            text=(exchange===0?['@client: use nextCursor.','Got it. Updating the UI.','I’ll test the empty page.','Reading the shared plan.']:['Saved the plan in a note.','@tests: UI is ready.','All pagination tests pass.','Reviewed. Ready to merge.'])[i];
            visible=exchange===0?(i===0||i===1):(i===2||i===3);
          }
          bubbles.push({...projected(point),text,visible,agent:['api-agent','client-agent','test-agent','review-agent'][i]});
        }
        hiddenFish.forEach((fish,i)=>{
          const reveal=ease(1.60+i*.12,1.98+i*.12,p)*(1-ease(2.35,2.75,p));
          fish.visible=reveal>.01;
          fish.scale.setScalar((.66+i*.07)*reveal);
          fish.position.set([-.35,2.7,.55][i],[-1.05,-2.05,-2.55][i], [3.4,2.1,1.35][i]);
          fish.rotation.y=[.4,-.6,.1][i];
          fish.updateWorldMatrix(true,false);
          bubbles.push({...projected(fish.getWorldPosition(V()).add(V(0,.55,0))),text:'doing something',visible:chapter===2&&reveal>.25,agent:'',subagent:true});
        });
        carrier.visible=arrive>.001&&retire<1;flight.getPoint(arrive,carrier.position);carrier.position.y+=Math.sin(time*.8)*.12+retire*22;
        carrier.scale.setScalar(1-retire*.65);
        const forward=flight.getTangent(arrive).normalize(), right=V().crossVectors(forward,Y).normalize(), up=V().crossVectors(right,forward);
        carrier.quaternion.setFromRotationMatrix(flightBasis.makeBasis(forward,up,right));
        carrier.rotateX(Math.sin(arrive*Math.PI*2)*.12*(1-arrive));
        for(const strap of harness){
          // Match the painted bass shader's lateral bend at the strap's body station.
          const localX=strap.x/3.5, aft=1-THREE.MathUtils.smoothstep(localX,-1.30,.35);
          strap.root.position.z=Math.sin(localX*3-time*3.3+fishes[0].phase)*.12*aft*aft*3.5;
        }
        carrier.updateMatrixWorld(true);
        for(let i=0;i<4;i++) {
          const arm=arms[i];arm.root.visible=carrier.visible;
          const sideX=Math.sign(centers[i].x),sideZ=Math.sign(centers[i].z);
          const strap=harness[sideX<0?0:1];
          const start=strap.root.localToWorld(V(0,-strap.height+.10,sideZ*(strap.depth+.15)));
          const fish=pods[i].fish.getWorldPosition(V());
          const end=fish.clone().add(V(.18,1.25,0));
          const folded=start.clone().add(V(0,-.4,0));
          const elbow=folded.clone().lerp(V(sideX*7.1,6.25,sideZ*6.4),extend);
          const wrist=folded.clone().lerp(end.clone().add(V(0,2.1,0)),extend);
          const microphone=wrist.clone().lerp(end,ease(4.20,4.70,p)*(1-retire));
          segment(arm.upper,start,elbow,.13);segment(arm.lower,elbow,wrist,.075);segment(arm.cable,wrist,microphone,.027);
          [start,elbow,wrist].forEach((point,j)=>arm.joints[j].position.copy(point));arm.mic.position.copy(microphone);
          arm.lamp.visible=connect>.1;
          arm.ripple.position.copy(fish).setY(.075);arm.ripple.material.opacity=connect*(.5-(time*.55+i*.25)%1*.4);arm.ripple.scale.setScalar(1+(time*.55+i*.25)%1*1.3);
          const cycle=(time*.28+i*.21)%1,t=i%2?1-cycle:cycle;
          arm.packet.visible=connect>.1;
          arm.packet.position.copy(t<1/3?microphone.clone().lerp(wrist,t*3):t<2/3?wrist.clone().lerp(elbow,t*3-1):elbow.clone().lerp(start,t*3-2));
        }
        if(Math.abs(p-lastProgress)>.001||lastViewport!==`${width}/${height}`)renderer.shadowMap.needsUpdate=true;
        lastProgress=p;lastViewport=`${width}/${height}`;
        const textEnter=ease(chapterStarts[chapter],chapterStarts[chapter]+.32,p);
        const textExit=chapter===6?0:ease(chapterStarts[chapter+1]-.18,chapterStarts[chapter+1],p);
        const textY=(1-textEnter)*height*.48-textExit*height*.16;
        const half=(POND_SIDE+.42)/2;
        const pondRects=pods.map(pod=>{
          const a=projected(pod.group.position.clone().add(V(-half,0,-half))),b=projected(pod.group.position.clone().add(V(half,0,half)));
          return {x:a.x*width,y:a.y*height,width:(b.x-a.x)*width,height:(b.y-a.y)*height};
        });
        state={chapter,progress:p,overhead,morph,pondRects,cameraDirection:camera.getWorldDirection(V()).toArray(),cameraQuaternion:camera.quaternion.toArray(),ponds:pods.filter(pod=>pod.group.visible).length,hiddenAgents:hiddenFish.filter(fish=>fish.visible).length,leadFishY:pods[0].fish.position.y,leadFishPosition:pods[0].fish.position.toArray(),carrier:carrier.visible,carrierPosition:carrier.position.toArray(),carrierForward:forward.toArray(),microphones:extend>.95?4:0,connected:connect>.9,orbit,sceneDrop,textY,carrierNose:projected(giant.localToWorld(V(1.12,0,0))),carrierTail:projected(giant.localToWorld(V(-1.92,0,0))),pondPoses:pods.map(pod=>({rotation:pod.group.rotation.y,...projected(pod.group.position)}))};
        onFrame?.({...state,time,width,height,paused,bubbles,textOpacity:1-textExit,heroOpacity:1-ease(.10,.52,p),heroY:-height*.16*ease(.10,.55,p),chapterChanged:chapter!==lastChapter,narrow});lastChapter=chapter;
      },
      getStats:()=>state,
      shouldRender:()=>state.morph!==1,
      dispose:()=>replacedMaterials.forEach(material=>material.dispose()),
    };
  };
}
