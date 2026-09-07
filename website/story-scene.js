import * as THREE from './backdrop/vendor/three.module.min.js';

const V = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const ease = (a,b,x) => { const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };

export const chapters = [
  { title:'Bassfish', body:'headless chat and notes for agent teams' },
  { title:'One agent is easy to follow.', body:'It works in your repo and surfaces when it needs you.' },
  { title:'A team is harder to see.', body:'One agent speaks for the team. The others work below the surface.' },
  { title:'Separate windows. Separate conversations.', body:'You can see each agent, but you’re still carrying messages between them.' },
  { title:'Give them a way to talk.', body:'Bassfish connects your agents through shared threads and notes.' },
  { title:'Now they can work together.', body:'Ask questions, agree on changes, and leave a plan the next agent can read.' },
];

// This extends the existing pond, sharing its texture maps and batched geometry.
export function createPondStory(onFrame) {
  return ({scene,world,camera,fishes,timeUniform,renderer,light}) => {
    const pods=[], hiddenFish=[], arms=[], replacedMaterials=new Set();
    let lastProgress=-1, lastChapter=-1, lastViewport='', state={};
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
    const giant=fishes[0].fish.clone(true);giant.position.set(0,0,0);giant.scale.setScalar(3.5);giant.rotation.y=-.12;carrier.add(giant);
    function item(geometry,material,parent=scene) { const mesh=new THREE.Mesh(geometry,material);parent.add(mesh);return mesh; }
    // Two narrow harness bands and four articulated arms give the bass its machine character.
    for(const x of [-1.75,1.3]) {
      const band=item(new THREE.TorusGeometry(1.04,.08,8,40),brass,carrier);band.rotation.y=Math.PI/2;band.scale.y=1.2;band.position.x=x;
      const mount=item(new THREE.BoxGeometry(.55,.35,1.8),dark,carrier);mount.position.set(x,-.75,0);
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
        const separate=ease(2.45,3.25,p), arrive=ease(3.5,4.12,p), extend=ease(3.95,4.65,p), connect=ease(4.5,4.95,p);
        const chapter=p<.55?0:p<1.62?1:p<2.62?2:p<3.65?3:p<4.8?4:5;
        const aspect=width/height, narrow=aspect<.85;
        const view=mix(narrow?17.5/aspect:22,narrow?35.5/aspect:40,separate);
        camera.left=-view*aspect/2;camera.right=view*aspect/2;camera.top=view/2;camera.bottom=-view/2;camera.updateProjectionMatrix();
        const elevation=mix(.56,.66,separate), focus=V(0,mix(-2.1,-.6,separate),0),yaw=.72;
        camera.position.set(Math.sin(yaw)*Math.cos(elevation)*36,Math.sin(elevation)*36+focus.y,Math.cos(yaw)*Math.cos(elevation)*36);camera.lookAt(focus);
        camera.updateMatrixWorld();
        const bubbles=[];
        for(let i=0;i<4;i++) {
          const pod=pods[i], reveal=i===0?1:ease(2.55+i*.10,3.05+i*.10,p);
          pod.group.visible=reveal>.001;
          pod.group.position.copy(centers[i]).multiplyScalar(separate);
          pod.group.position.y=i===0?0:-7*(1-reveal);
          pod.group.scale.setScalar(i===0?1:Math.max(.001,reveal));
          pod.group.rotation.y=i===0?0:rotations[i]-(1-reveal)*Math.PI/2;
          const rise=ease(.55,.98,p), bob=Math.sin(time*1.4+i)*.06;
          pod.fish.position.set(1.15+Math.sin(time*.3+i)*.12,mix(-1.55,.15,rise)+bob,mix(3.55,2.05,rise));
          pod.fish.rotation.set(0,.17,Math.sin(time*.7+i)*.035);
          pod.group.updateMatrixWorld(true);pod.inverse.value.copy(pod.group.matrixWorld).invert();
          for(const record of pod.clipping)record.planes.forEach((plane,j)=>plane.copy(record.original[j]).applyMatrix4(pod.group.matrixWorld));
          const point=pod.fish.getWorldPosition(V()).add(V(.45,chapter===5?2.25:.65,.15));
          let text='',visible=false;
          if(chapter===1&&i===0) {text=['Editing api.ts…','I have a question.','Please approve this change.'][Math.min(2,Math.floor((p-.55)/1.07*3))];visible=true;}
          if(chapter===2&&i===0) {text=['Delegating three tasks…','The team is still working.','Please approve this change.'][Math.min(2,Math.floor((p-1.62)*3))];visible=true;}
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
        });
        carrier.visible=arrive>.001;carrier.position.set(mix(-31,0,arrive),mix(20,12.5,arrive)+Math.sin(time*.8)*.12,0);
        carrier.rotation.z=mix(-.20,0,arrive);carrier.updateMatrixWorld(true);
        for(let i=0;i<4;i++) {
          const arm=arms[i];arm.root.visible=arrive>.001;
          const sideX=Math.sign(centers[i].x),sideZ=Math.sign(centers[i].z);
          const start=carrier.localToWorld(V(sideX<0?-1.75:1.3,-.85,sideZ));
          const fish=pods[i].fish.getWorldPosition(V());
          const end=fish.clone().add(V(.18,1.25,0));
          const folded=start.clone().add(V(0,-.4,0));
          const elbow=folded.clone().lerp(V(sideX*7.1,6.25,sideZ*6.4),extend);
          const wrist=folded.clone().lerp(end.clone().add(V(0,2.1,0)),extend);
          const microphone=wrist.clone().lerp(end,ease(4.20,4.70,p));
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
        state={chapter,progress:p,ponds:pods.filter(pod=>pod.group.visible).length,hiddenAgents:hiddenFish.filter(fish=>fish.visible).length,leadFishY:pods[0].fish.position.y,carrier:carrier.visible,microphones:extend>.95?4:0,connected:connect>.9,pondPoses:pods.map(pod=>({rotation:pod.group.rotation.y,...projected(pod.group.position)}))};
        onFrame?.({...state,bubbles,chapterChanged:chapter!==lastChapter,narrow});lastChapter=chapter;
      },
      getStats:()=>state,
      dispose:()=>replacedMaterials.forEach(material=>material.dispose()),
    };
  };
}
