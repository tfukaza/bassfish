import * as THREE from '../vendor/three.module.min.js';

export function buildBass({world,timeUniform}){
  const textures=[],loads=[];
  const loader=new THREE.TextureLoader();
  function texture(name,version=1){
    let resolve,reject;loads.push(new Promise((yes,no)=>{resolve=yes;reject=no;}));
    const map=loader.load(new URL(`./fish/${name}-v${version}.png`,import.meta.url).href,resolve,undefined,()=>reject(new Error(`Unable to load the ${name} fish texture.`)));
    map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=4;textures.push(map);return map;
  }
  const bodyMap=texture('bass-body',2),finMap=texture('bass-fins');
  function paintedMaterial(map,phase){
    const mat=new THREE.MeshBasicMaterial({map,side:THREE.DoubleSide,toneMapped:false});
    // One deformation for body and fins keeps every attachment together while swimming.
    mat.onBeforeCompile=shader=>{
      shader.uniforms.uPondTime=timeUniform;
      shader.vertexShader='uniform float uPondTime;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        float aft=1.-smoothstep(-1.30,.35,position.x);
        transformed.z+=sin(position.x*3.-uPondTime*3.3+${phase.toFixed(3)})*.12*aft*aft;
      `);
    };
    mat.customProgramCacheKey=()=>`painted-bass-${phase}`;return mat;
  }
  function makeBass(scale,phase){
    const fish=new THREE.Group();fish.userData.dynamic=true;fish.name='textured-bass';fish.scale.setScalar(scale);world.add(fish);
    const bodyMaterial=paintedMaterial(bodyMap,phase),finMaterial=paintedMaterial(finMap,phase);
    function mesh(geometry,material){const item=new THREE.Mesh(geometry,material);fish.add(item);return item;}
    // A full cheek and short blunt nose replace the former pointed snout.
    const profiles=[[-1.43,.001,.001],[-1.36,.075,.043],[-1.14,.145,.083],[-.84,.265,.16],[-.47,.385,.233],[-.03,.41,.26],[.34,.38,.275],[.67,.325,.235],[.89,.26,.18],[1.02,.18,.105],[1.09,.08,.046],[1.12,.001,.001]];
    const curve=new THREE.CatmullRomCurve3(profiles.map(p=>new THREE.Vector3(...p)));
    const positions=[],uvs=[],indices=[],rings=64,sides=32;
    for(let i=0;i<=rings;i++)for(let j=0;j<=sides;j++){
      const p=curve.getPoint(i/rings),angle=j/sides*Math.PI*2;
      positions.push(p.x,Math.cos(angle)*p.y,Math.sin(angle)*p.z);
      // Side projection mirrors the same flank onto both sides; the back and belly meet cleanly.
      uvs.push((p.x+1.43)/2.55,(Math.cos(angle)+1)/2);
      if(i<rings&&j<sides){const k=i*(sides+1)+j;indices.push(k,k+1,k+sides+1,k+1,k+sides+2,k+sides+1);}
    }
    const bodyGeometry=new THREE.BufferGeometry();
    bodyGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    bodyGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));bodyGeometry.setIndex(indices);bodyGeometry.computeVertexNormals();
    mesh(bodyGeometry,bodyMaterial);

    function fin(points,root){
      const positions=[],uvs=[];
      const origin=new THREE.Vector3(...root),outer=points.map(p=>new THREE.Vector3(...p).sub(origin));
      const across=outer[0].clone().sub(outer.at(-1)).normalize();
      const normal=outer[0].clone().cross(outer.at(-1)).normalize();
      const outward=normal.cross(across).normalize();
      if(outer.reduce((sum,p)=>sum+p.dot(outward),0)<0)outward.negate();
      const width=2*Math.max(...outer.map(p=>Math.abs(p.dot(across))));
      const height=Math.max(...outer.map(p=>p.dot(outward)));
      const mapped=outer.map(p=>[.5+p.dot(across)/width,p.dot(outward)/height]);
      for(let i=0;i<points.length-1;i++){
        positions.push(...root,...points[i],...points[i+1]);
        // A planar projection preserves straight fin rays across triangle boundaries.
        uvs.push(.5,0,...mapped[i],...mapped[i+1]);
      }
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.computeVertexNormals();return mesh(geometry,finMaterial);
    }
    fin([[-1.30,.075,0],[-1.92,.40,0],[-1.87,.18,0],[-1.83,0,0],[-1.87,-.18,0],[-1.92,-.40,0],[-1.30,-.075,0]],[-1.32,0,0]);
    fin([[.45,.35,0],[.23,.59,0],[.13,.44,0],[.01,.62,0],[-.10,.44,0],[-.24,.58,0],[-.33,.42,0],[-.52,.49,0],[-.69,.53,0],[-.86,.44,0],[-1.05,.22,0]],[-.36,.30,0]);
    fin([[-.40,-.32,0],[-.58,-.57,0],[-.86,-.53,0],[-1.03,-.21,0]],[-.70,-.27,0]);
    for(const side of [-1,1]){
      fin([[.47,-.035,.24*side],[.10,-.31,.41*side],[-.22,-.19,.24*side]],[.42,-.02,.22*side]);
      fin([[.20,-.29,.15*side],[-.01,-.58,.28*side],[-.24,-.35,.16*side]],[.07,-.28,.15*side]);
    }
    return {fish,phase};
  }
  const fishes=[makeBass(.94,1.05),makeBass(.47,3.2)];
  return {
    fishes,ready:Promise.all(loads),
    getStats:()=>({texturedBass:fishes.length,fishTextures:textures.length}),
    // Geometry and materials belong to the scene's shared disposal pass.
    dispose:()=>textures.forEach(map=>map.dispose()),
  };
}
