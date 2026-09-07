import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const vertex = `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const noise = `
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
`;

// A lathed body with a broad head, narrow caudal peduncle, and separate fins.
// Everything is authored here; there are no model or texture downloads.
function bassGeometry() {
  const profiles = [
    [-2.35,.13,.085,-.02],[-2.05,.23,.14,-.01],[-1.65,.43,.25,.015],
    [-1.1,.65,.36,.03],[-.45,.81,.43,.04],[.2,.82,.46,.04],
    [.75,.71,.42,.045],[1.15,.53,.34,.035],[1.5,.32,.255,-.04],[1.7,.17,.18,-.11],
  ];
  const curve = new THREE.CatmullRomCurve3(profiles.map(p=>new THREE.Vector3(p[0],p[1],p[2])));
  const positions=[],uvs=[],indices=[];
  const rings=76,sides=40;
  for(let i=0;i<=rings;i++) {
    const u=i/rings,p=curve.getPoint(u);
    for(let j=0;j<=sides;j++) {
      const a=j/sides*TAU;
      positions.push(p.x,Math.cos(a)*p.y + .025 - Math.max(0,p.x-1.15)*.24, Math.sin(a)*p.z);
      uvs.push(u,j/sides);
    }
  }
  for(let i=0;i<rings;i++) for(let j=0;j<sides;j++) {
    const a=i*(sides+1)+j,b=a+sides+1;
    indices.push(a,b,a+1,b,b+1,a+1);
  }
  const body=new THREE.BufferGeometry();
  body.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  body.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  body.setIndex(indices);body.computeVertexNormals();
  return body;
}

function finGeometry(points,root) {
  const positions=[],uv=[];
  for(let i=0;i<points.length-1;i++) {
    positions.push(...root,...points[i],...points[i+1]);
    uv.push(.5,0,i/(points.length-1),1,(i+1)/(points.length-1),1);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geometry.computeVertexNormals();return geometry;
}

const fishVertex=`
uniform float uTime; uniform float uPhase;
varying vec3 vNormal; varying vec3 vWorld; varying vec3 vLocal; varying vec2 vUv;
void main(){
  vUv=uv;vLocal=position;
  vec3 p=position;
  float tail=1.-smoothstep(-2.7,.7,p.x);
  p.z+=sin(p.x*1.8-uTime*2.8+uPhase)*.23*tail*tail;
  vNormal=normalize(mat3(modelMatrix)*normal);
  vWorld=(modelMatrix*vec4(p,1.)).xyz;
  gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);
}`;

const fishFragment=`
uniform float uTime; uniform float uMoon; uniform float uFin; uniform float uSignal;
varying vec3 vNormal; varying vec3 vWorld; varying vec3 vLocal; varying vec2 vUv;
${noise}
void main(){
  vec3 n=normalize(vNormal); if(!gl_FrontFacing)n=-n;
  vec3 view=normalize(cameraPosition-vWorld);
  float rim=pow(1.-abs(dot(n,view)),3.3);
  float light=max(0.,dot(n,normalize(vec3(-.5,1.4,1.6))));
  float belly=1.-smoothstep(-.55,.45,vLocal.y);
  vec3 base=mix(vec3(.065,.20,.17),vec3(.47,.56,.42),belly*.85);
  base=mix(base,vec3(.12,.20,.28)+belly*vec3(.3,.35,.38),uMoon*.75);
  float lateral=exp(-pow((vLocal.y+.045)/.13,2.))*smoothstep(1.5,.3,vLocal.x);
  base*=1.-lateral*(.35+.3*noise(vLocal.xy*13.));
  vec2 cells=vec2(vUv.x*66.,vUv.y*34.);
  cells.x+=mod(floor(cells.y),2.)*.5;
  vec2 f=fract(cells)-.5;
  float scale=pow(max(0.,1.-length(f*vec2(1.,1.4))*1.6),3.);
  float scaleEdge=smoothstep(.04,0.,abs(length(f*vec2(1.,1.25))-.46));
  float spec=pow(max(dot(reflect(-normalize(vec3(-.6,1.3,2.)),n),view),0.),38.);
  vec3 color=base*(.22+light*.8)+vec3(.36,.70,.6)*scale*.07*light;
  color+=scaleEdge*.032+vec3(.61,.85,.73)*spec*.85+vec3(.21,.64,.58)*rim*.48;
  // Occasional narrow scan band follows the body; it never replaces the silhouette.
  float scan=exp(-pow((vLocal.x-(mod(uTime*.34,8.)-4.))/.11,2.));
  color+=vec3(.16,.65,.53)*scan*.45;
  color+=vec3(.25,.85,.69)*uSignal*.13;
  if(uFin>.5){
    float ray=pow(.5+.5*cos(vUv.x*100.),12.);
    color=mix(vec3(.06,.23,.20),vec3(.28,.52,.40),light*.6)+ray*.09+rim*vec3(.08,.22,.18);
  }
  float depth=length(cameraPosition-vWorld);
  color=mix(color,mix(vec3(.012,.061,.068),vec3(.018,.036,.074),uMoon),1.-exp(-depth*.022));
  gl_FragColor=vec4(color,uFin>.5?.78:1.);
}`;

export function mountBassfishBackdrop(container, options={}) {
  const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion=motionQuery.matches;
  let paused=options.paused??reducedMotion,disposed=false,raf=0,elapsed=8,previous=0;
  let moonTarget=0,compositionTarget=0,pulseAge=10;
  const pointer=new THREE.Vector2(),smoothPointer=new THREE.Vector2();
  let seed=48291;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const renderer=new THREE.WebGLRenderer({antialias:false,alpha:false,powerPreference:'low-power'});
  renderer.setPixelRatio(1);
  renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x04171b,1);
  renderer.domElement.setAttribute('aria-hidden','true');
  container.appendChild(renderer.domElement);
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(39,1,.1,100);
  camera.position.set(0,1.2,16);
  const target=new THREE.Vector3(.3,.2,0);
  const common={uTime:{value:elapsed},uMoon:{value:0},uSignal:{value:0}};
  const background=new THREE.Scene();
  const flatCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const plane=new THREE.PlaneGeometry(2,2);
  const bgMat=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{...common,uAspect:{value:1},uPointer:{value:smoothPointer}},vertexShader:vertex,fragmentShader:`
    varying vec2 vUv;uniform float uTime;uniform float uAspect;uniform float uMoon;uniform vec2 uPointer;
    ${noise}
    void main(){
      vec2 uv=vUv;vec2 p=uv+uPointer*.012;
      vec3 deep=mix(vec3(.009,.038,.045),vec3(.012,.025,.061),uMoon);
      vec3 water=mix(vec3(.026,.135,.131),vec3(.05,.095,.18),uMoon);
      float pool=exp(-length((p-vec2(.66,1.07))*vec2(1.2,.95))*2.6);
      vec3 col=mix(deep,water,pool*.93);
      float rays=0.;
      for(int i=0;i<7;i++){
        float k=float(i);float source=.38+k*.076;
        float x=p.x-source+(1.-p.y)*(.24+k*.012);
        float width=.012+(1.-p.y)*.048;
        rays+=exp(-x*x/(width*width))* (.45+.35*sin(uTime*.23+k*3.))*.032;
      }
      col+=rays*vec3(.39,.65,.57)*pow(uv.y,1.2);
      float ripple=sin(p.x*47.+sin(p.x*13.+uTime*.24)*2.+p.y*17.-uTime*.3);
      float surface=pow(max(0.,ripple),7.)*exp(-(1.-p.y)*27.);
      col+=surface*vec3(.08,.18,.16);
      float haze=noise(vec2(p.x*4.+uTime*.015,p.y*5.))*.018;
      col+=haze*vec3(.24,.6,.55);
      gl_FragColor=vec4(col,1.);
    }`});
  background.add(new THREE.Mesh(plane,bgMat));

  // Seabed: gently folded sediment with very faint coordinate traces and caustics.
  const floorGeometry=new THREE.PlaneGeometry(85,60,130,100);
  floorGeometry.rotateX(-Math.PI/2);
  const fp=floorGeometry.attributes.position;
  for(let i=0;i<fp.count;i++) {
    const x=fp.getX(i),z=fp.getZ(i);
    fp.setY(i,-4.35+Math.sin(x*.27+z*.2)*.22+Math.sin(z*.51-x*.13)*.16);
  }
  floorGeometry.computeVertexNormals();
  const floorMat=new THREE.ShaderMaterial({uniforms:{...common,uPulseAge:{value:10},uPulseOrigin:{value:new THREE.Vector2(2,0)}},vertexShader:`varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`
    varying vec3 vP;uniform float uTime;uniform float uMoon;uniform float uPulseAge;uniform vec2 uPulseOrigin;
    ${noise}
    void main(){
      vec2 p=vP.xz;
      float s=noise(p*2.4),d=length(p-vec2(2.,-3.));
      vec3 col=mix(vec3(.025,.065,.064),vec3(.027,.042,.075),uMoon)*(.65+s*.55);
      vec2 q=p*.63+vec2(sin(p.y*.7+uTime*.21),cos(p.x*.62-uTime*.19))*.6;
      float caustic=pow(1.-abs(sin(q.x+sin(q.y))*cos(q.y+cos(q.x))),15.);
      col+=caustic*vec3(.05,.12,.10)*exp(-d*.055)*.7;
      vec2 g=abs(fract(p*.42-.5)-.5)/max(fwidth(p*.42),vec2(.001));
      float grid=1.-min(min(g.x,g.y),1.);
      col+=grid*vec3(.025,.065,.058)*exp(-d*.085);
      float radius=uPulseAge*3.6;
      float ring=exp(-pow((length(p-uPulseOrigin)-radius)/.09,2.))*exp(-uPulseAge*.65);
      col+=ring*vec3(.18,.6,.47);
      float fog=1.-exp(-length(cameraPosition-vP)*.042);
      col=mix(col,mix(vec3(.015,.066,.071),vec3(.02,.036,.071),uMoon),fog);
      gl_FragColor=vec4(col,1.);
    }`});
  scene.add(new THREE.Mesh(floorGeometry,floorMat));

  const bodyGeo=bassGeometry();
  const fins=[
    finGeometry([[-2.2,.13,0],[-3.05,.82,0],[-3.,.44,0],[-2.8,0,0],[-3.,-.45,0],[-3.05,-.78,0],[-2.2,-.13,0]],[-2.28,0,0]),
    finGeometry([[.6,.69,0],[.36,1.15,0],[.13,.99,0],[-.07,1.36,0],[-.3,1.14,0],[-.53,1.4,0],[-.77,1.14,0],[-1.,1.24,0],[-1.25,.9,0],[-1.4,.61,0]],[-.35,.7,0]),
    finGeometry([[-1.1,.62,0],[-1.46,1.05,0],[-1.83,.99,0],[-2.1,.33,0]],[-1.7,.4,0]),
    finGeometry([[-1.0,-.61,0],[-1.39,-1.03,0],[-1.87,-.85,0],[-1.93,-.29,0]],[-1.43,-.39,0]),
    finGeometry([[.6,-.22,.39],[.2,-.54,.88],[-.42,-.53,.75],[-.04,-.29,.41]],[.55,-.21,.4]),
    finGeometry([[.6,-.22,-.39],[.2,-.54,-.88],[-.42,-.53,-.75],[-.04,-.29,-.41]],[.55,-.21,-.4]),
    finGeometry([[.13,-.71,0],[-.38,-1.11,.24],[-.59,-.75,.1]],[.02,-.62,0]),
  ];
  function makeFish(scale,phase,detail=false) {
    const fish=new THREE.Group();
    const mat=new THREE.ShaderMaterial({uniforms:{...common,uPhase:{value:phase},uFin:{value:0}},vertexShader:fishVertex,fragmentShader:fishFragment,side:THREE.DoubleSide});
    const finMat=mat.clone();finMat.uniforms={...common,uPhase:mat.uniforms.uPhase,uFin:{value:1}};finMat.transparent=true;finMat.depthWrite=false;
    fish.add(new THREE.Mesh(bodyGeo,mat));
    fins.forEach(geo=>fish.add(new THREE.Mesh(geo,finMat)));
    if(detail){
      // Eye rings, gill plates, and a slanted mouth make the bass readable in silhouette.
      for(const side of [-1,1]){
        const eye=new THREE.Mesh(new THREE.SphereGeometry(.073,16,12),new THREE.MeshBasicMaterial({color:0x9fba94}));
        eye.position.set(1.13,.29,.292*side);eye.scale.z=.45;fish.add(eye);
        const pupil=new THREE.Mesh(new THREE.SphereGeometry(.042,12,8),new THREE.MeshBasicMaterial({color:0x031815}));
        pupil.position.copy(eye.position);pupil.position.z+=.025*side;pupil.scale.z=.4;fish.add(pupil);
        const shine=new THREE.Mesh(new THREE.SphereGeometry(.016,8,6),new THREE.MeshBasicMaterial({color:0xd6ece0}));
        shine.position.copy(pupil.position);shine.position.y+=.02;shine.position.x-=.012;shine.position.z+=.017*side;fish.add(shine);
        const curve=new THREE.CatmullRomCurve3([new THREE.Vector3(.62,.59,.22*side),new THREE.Vector3(.36,.32,.416*side),new THREE.Vector3(.32,-.16,.46*side),new THREE.Vector3(.56,-.55,.29*side)]);
        fish.add(new THREE.Mesh(new THREE.TubeGeometry(curve,30,.012,5,false),new THREE.MeshBasicMaterial({color:0x244d43})));
        const lip=new THREE.CatmullRomCurve3([new THREE.Vector3(1.73,-.075,.16*side),new THREE.Vector3(1.42,-.22,.255*side),new THREE.Vector3(1.04,-.12,.355*side)]);
        fish.add(new THREE.Mesh(new THREE.TubeGeometry(lip,22,.012,5,false),new THREE.MeshBasicMaterial({color:0x14392f})));
      }
    }
    fish.scale.setScalar(scale);scene.add(fish);return fish;
  }
  const hero=makeFish(1.12,.6,true);
  const escorts=[makeFish(.48,2.3,true),makeFish(.31,4.2,false)];
  const school=[];
  for(let i=0;i<24;i++){
    const fish=makeFish(.07+random()*.09,random()*TAU);
    school.push({fish,x:(random()-.5)*18,y:random()*4+.1,z:-7-random()*9,phase:random()*TAU,speed:.1+random()*.14});
  }

  // A warm, suspended lure is the single focal accent.
  const lure=new THREE.Group();scene.add(lure);
  const amber=new THREE.MeshBasicMaterial({color:new THREE.Color(2.2,1.12,.36)});
  const lureBody=new THREE.Mesh(new THREE.SphereGeometry(.085,20,16),amber);lureBody.scale.set(1,2.9,.7);lure.add(lureBody);
  const collar=new THREE.Mesh(new THREE.TorusGeometry(.069,.011,6,16),new THREE.MeshBasicMaterial({color:0x735138}));collar.rotation.x=Math.PI/2;collar.position.y=.035;lure.add(collar);
  const hookCurve=new THREE.CatmullRomCurve3([new THREE.Vector3(0,-.2,0),new THREE.Vector3(.025,-.34,0),new THREE.Vector3(.11,-.41,0),new THREE.Vector3(.18,-.37,0),new THREE.Vector3(.18,-.28,0)]);
  const hook=new THREE.Mesh(new THREE.TubeGeometry(hookCurve,30,.009,6,false),new THREE.MeshBasicMaterial({color:0xacb8a0}));lure.add(hook);
  const fishingLineGeo=new THREE.BufferGeometry().setFromPoints(Array.from({length:81},()=>new THREE.Vector3()));
  const fishingLine=new THREE.Line(fishingLineGeo,new THREE.LineBasicMaterial({color:0xbdd7bb,transparent:true,opacity:.48}));scene.add(fishingLine);
  const signalBead=new THREE.Mesh(new THREE.SphereGeometry(.025,8,8),new THREE.MeshBasicMaterial({color:new THREE.Color(1.8,2.2,1.7)}));scene.add(signalBead);

  // Dust is GPU animated, with soft discs instead of hard confetti pixels.
  const particleCount=420,particleGeo=new THREE.BufferGeometry(),dust=[],sizes=[],phases=[];
  for(let i=0;i<particleCount;i++){dust.push((random()-.5)*35,(random()-.5)*18,(random()-.5)*28);sizes.push(.4+random()*1.6);phases.push(random()*TAU);}
  particleGeo.setAttribute('position',new THREE.Float32BufferAttribute(dust,3));particleGeo.setAttribute('aSize',new THREE.Float32BufferAttribute(sizes,1));particleGeo.setAttribute('aPhase',new THREE.Float32BufferAttribute(phases,1));
  const particleMat=new THREE.ShaderMaterial({uniforms:{...common,uDpr:{value:1}},transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexShader:`
    uniform float uTime;uniform float uDpr;attribute float aSize;attribute float aPhase;varying float vAlpha;
    void main(){vec3 p=position;p.x+=sin(uTime*.09+aPhase)*.48;p.y=mod(p.y+uTime*.042+9.,18.)-9.;vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*30./-mv.z,1.,5.)*uDpr;vAlpha=(.18+.14*sin(aPhase+uTime*.35))*smoothstep(0.,3.,-mv.z);}`,fragmentShader:`varying float vAlpha;void main(){float d=length(gl_PointCoord-.5)*2.;float a=exp(-d*d*4.)*(1.-smoothstep(.5,1.,d));gl_FragColor=vec4(.42,.69,.61,a*vAlpha);}`});
  scene.add(new THREE.Points(particleGeo,particleMat));

  // Fine curved routes behind the fish carry short, widely spaced light packets.
  const routes=[];
  for(let i=0;i<4;i++){
    const path=new THREE.CatmullRomCurve3([new THREE.Vector3(-13,-1.4+i*.48,-5-i*.5),new THREE.Vector3(-4,-2.2+i*.4,-4),new THREE.Vector3(4,-1.7+i*.42,-3),new THREE.Vector3(11,1+i*.7,-6)]);
    const geo=new THREE.BufferGeometry().setFromPoints(path.getPoints(140));
    scene.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:0x376f64,transparent:true,opacity:.13})));
    const packet=new THREE.Mesh(new THREE.SphereGeometry(.022,7,6),new THREE.MeshBasicMaterial({color:new THREE.Color(.38,1.2,.92)}));scene.add(packet);routes.push({path,packet,offset:i*.23});
  }
  const rippleGroup=new THREE.Group();scene.add(rippleGroup);
  const rippleMat=new THREE.MeshBasicMaterial({color:0x9ce4c6,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const ripple=new THREE.Mesh(new THREE.RingGeometry(.985,1,180),rippleMat);rippleGroup.add(ripple);

  // A lightweight HDR composite adds restrained bloom, grain, and a soft vignette.
  const rt=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:true,samples:0});
  const postScene=new THREE.Scene();
  const postMat=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{tScene:{value:rt.texture},uResolution:{value:new THREE.Vector2(1,1)},uTime:common.uTime,uComposition:{value:0}},vertexShader:vertex,fragmentShader:`
    varying vec2 vUv;uniform sampler2D tScene;uniform vec2 uResolution;uniform float uTime;uniform float uComposition;
    float grain(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
    void main(){
      vec2 uv=vUv;vec3 col=texture2D(tScene,uv).rgb;vec3 bloom=vec3(0.);
      for(int i=0;i<12;i++){float a=float(i)*6.283185/12.;vec2 delta=vec2(cos(a),sin(a))/uResolution*5.;vec3 s=texture2D(tScene,uv+delta).rgb;bloom+=max(s-.5,0.);vec3 w=texture2D(tScene,uv+delta*3.).rgb;bloom+=max(w-.65,0.)*.35;}
      col+=bloom*.06;
      col*=1.-.34*pow(length((uv-.5)*vec2(1.05,.9)),1.6);
      col*=1.-uComposition*(1.-smoothstep(.05,.65,uv.x))*.35;
      col=1.-exp(-col*1.65);
      col=pow(max(col,0.),vec3(1./2.2));
      col+=(grain(uv*uResolution)-.5)*.009;
      gl_FragColor=vec4(col,1.);
    }`});
  postScene.add(new THREE.Mesh(plane,postMat));
  let width=1,height=1,dpr=1,visible=true,frameCount=0;
  function resize(){
    width=Math.max(1,container.clientWidth);height=Math.max(1,container.clientHeight);
    dpr=Math.min(devicePixelRatio||1,options.pixelRatio??1.5);
    const cap=width<760?1.35:1.5;dpr=Math.min(dpr,cap);
    renderer.setSize(width,height,false);rt.setSize(Math.round(width*dpr),Math.round(height*dpr));
    renderer.setPixelRatio(dpr);camera.aspect=width/height;camera.updateProjectionMatrix();
    bgMat.uniforms.uAspect.value=width/height;postMat.uniforms.uResolution.value.set(width*dpr,height*dpr);particleMat.uniforms.uDpr.value=dpr;
    render(0);
  }
  function render(dt){
    const smooth=dt?1.-Math.exp(-dt*2.7):1.;
    smoothPointer.lerp(pointer,reducedMotion?0:smooth);
    common.uTime.value=elapsed;
    common.uMoon.value=mix(common.uMoon.value,moonTarget,smooth);
    common.uSignal.value=Math.exp(-pulseAge*1.1);
    floorMat.uniforms.uPulseAge.value=pulseAge;
    postMat.uniforms.uComposition.value=mix(postMat.uniforms.uComposition.value,compositionTarget,smooth);
    const narrow=width<760;
    camera.position.set(smoothPointer.x*.55,1.15+smoothPointer.y*.24,narrow?22:16);
    target.set(narrow?1.5:.3,.1+smoothPointer.y*.16,0);camera.lookAt(target);
    const t=elapsed;
    hero.position.set(narrow?2.25:3.1,Math.sin(t*.3)*.15+(narrow?-.8:.15),.65+Math.sin(t*.21)*.15);
    hero.rotation.set(.035+Math.sin(t*.4)*.024,Math.PI+.14+Math.sin(t*.19)*.13,Math.sin(t*.28)*.03-.04);
    escorts[0].position.set(5.65,-1.7+Math.sin(t*.36)*.15,-3.6);escorts[0].rotation.set(.03,Math.PI+.17,-.05);
    escorts[1].position.set(.9,2.1+Math.sin(t*.32)*.08,-5.1);escorts[1].rotation.set(.02,Math.PI-.25,.02);
    for(const s of school){
      s.fish.position.set(((s.x-t*s.speed+18)%36+36)%36-18,s.y+Math.sin(t*.35+s.phase)*.23,s.z);
      s.fish.rotation.set(0,Math.PI+.18+Math.sin(t*.2+s.phase)*.12,Math.sin(s.phase+t*.3)*.035);
    }
    lure.position.set(.06+Math.sin(t*.31)*.12,-.02+Math.sin(t*.49)*.06,1.0);lure.rotation.z=Math.sin(t*.41)*.08;
    const line=fishingLineGeo.attributes.position;
    for(let i=0;i<=80;i++){
      const u=i/80;
      line.setXYZ(i,lure.position.x+Math.sin(u*Math.PI)*(.42+Math.sin(t*.24)*.13)+u*u*1.3,lure.position.y+.26+u*9.2,lure.position.z-.2*u);
    }
    line.needsUpdate=true;
    const packetU=1.-((t*.12)%1);
    signalBead.position.set(lure.position.x+Math.sin(packetU*Math.PI)*(.42+Math.sin(t*.24)*.13)+packetU*packetU*1.3,lure.position.y+.26+packetU*9.2,lure.position.z-.2*packetU);
    for(const r of routes)r.packet.position.copy(r.path.getPoint((t*.035+r.offset)%1));
    rippleGroup.position.copy(lure.position);rippleGroup.quaternion.copy(camera.quaternion);
    const rippleSize=.18+pulseAge*2.1;ripple.scale.setScalar(rippleSize);rippleMat.opacity=pulseAge<4?Math.exp(-pulseAge*1.3)*.35:0;
    renderer.setRenderTarget(rt);renderer.autoClear=true;renderer.render(background,flatCamera);renderer.autoClear=false;renderer.clearDepth();renderer.render(scene,camera);
    renderer.setRenderTarget(null);renderer.autoClear=true;renderer.render(postScene,flatCamera);frameCount++;
  }
  function tick(now){
    if(disposed)return;
    const dt=previous?Math.min((now-previous)/1000,.05):0;previous=now;
    if(!paused&&visible){elapsed+=dt;pulseAge+=dt;render(dt);}
    raf=requestAnimationFrame(tick);
  }
  function signal(){pulseAge=0;if(paused){pulseAge=.6;render(0);} }
  const onPointer=e=>{const rect=container.getBoundingClientRect();pointer.set(clamp((e.clientX-rect.left)/width*2-1,-1,1),clamp(1-(e.clientY-rect.top)/height*2,-1,1));};
  const onLeave=()=>pointer.set(0,0);
  const onVisibility=()=>{visible=!document.hidden;previous=0;};
  const onMotion=()=>{if(motionQuery.matches){paused=true;render(0);}};
  const onContextLost=e=>{e.preventDefault();paused=true;container.style.backgroundImage='url("'+new URL('./poster.jpg',import.meta.url).href+'")';container.style.backgroundSize='cover';renderer.domElement.style.opacity='0';};
  container.addEventListener('pointermove',onPointer);container.addEventListener('pointerleave',onLeave);container.addEventListener('click',signal);
  document.addEventListener('visibilitychange',onVisibility);motionQuery.addEventListener('change',onMotion);renderer.domElement.addEventListener('webglcontextlost',onContextLost);
  const observer=new ResizeObserver(resize);observer.observe(container);
  resize();raf=requestAnimationFrame(tick);
  return {
    get paused(){return paused;},reducedMotion,
    setPaused(value){paused=Boolean(value);previous=0;if(paused)render(0);},
    setPalette(name){moonTarget=name==='moonlight'?1:0;if(paused)render(0);},
    setComposition(name){compositionTarget=name==='hero'?1:0;if(paused)render(0);},
    signal,
    getStats(){return {frames:frameCount,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,width,height,pixelRatio:dpr,paused,elapsed,threeRevision:THREE.REVISION};},
    dispose(){
      if(disposed)return;disposed=true;cancelAnimationFrame(raf);observer.disconnect();
      container.removeEventListener('pointermove',onPointer);container.removeEventListener('pointerleave',onLeave);container.removeEventListener('click',signal);document.removeEventListener('visibilitychange',onVisibility);motionQuery.removeEventListener('change',onMotion);renderer.domElement.removeEventListener('webglcontextlost',onContextLost);
      const geometries=new Set(),materials=new Set();
      for(const root of [scene,background,postScene])root.traverse(object=>{if(object.geometry)geometries.add(object.geometry);if(object.material)materials.add(object.material);});
      geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());rt.dispose();renderer.dispose();renderer.domElement.remove();
    },
  };
}
