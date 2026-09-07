import * as THREE from '../vendor/three.module.min.js';
import { POND_HALF } from './dimensions.js';

const smooth=t=>t*t*(3-2*t);

export function roundedRockGeometry(segments=32,rings=20){
  // Smooth the intersections of the dodecahedron's supporting planes. Broad faces
  // survive, but the silhouette and lighting roll continuously across each edge.
  const source=new THREE.DodecahedronGeometry(1,0),planes=[];
  const p=source.attributes.position,n=source.attributes.normal;
  for(let i=0;i<p.count;i+=3){
    const normal=new THREE.Vector3().fromBufferAttribute(n,i).normalize();
    if(planes.some(plane=>plane.normal.dot(normal)>.9999))continue;
    planes.push({normal,distance:normal.dot(new THREE.Vector3().fromBufferAttribute(p,i))});
  }
  source.dispose();
  const geometry=new THREE.SphereGeometry(1,segments,rings),positions=geometry.attributes.position;
  for(let i=0;i<positions.count;i++){
    const direction=new THREE.Vector3().fromBufferAttribute(positions,i).normalize();
    const distances=planes.filter(plane=>plane.normal.dot(direction)>.05).map(plane=>plane.distance/plane.normal.dot(direction));
    const nearest=Math.min(...distances),radius=nearest-.085*Math.log(distances.reduce((sum,d)=>sum+Math.exp((nearest-d)/.085),0));
    const point=direction.clone().multiplyScalar(radius);
    point.x*=1+.055*direction.y-.035*direction.z;
    point.y=point.y*.73+point.x*.04;
    point.z*=.96+.045*direction.x;
    positions.setXYZ(i,point.x,point.y,point.z);
  }
  geometry.computeVertexNormals();
  // Average the duplicated UV seam and pole normals without changing texture UVs.
  const normals=geometry.attributes.normal,groups=new Map();
  for(let i=0;i<positions.count;i++){
    const key=[positions.getX(i),positions.getY(i),positions.getZ(i)].map(v=>Math.round(v*1e5)).join('/');
    if(!groups.has(key))groups.set(key,{normal:new THREE.Vector3(),indices:[]});
    const group=groups.get(key);group.normal.add(new THREE.Vector3().fromBufferAttribute(normals,i));group.indices.push(i);
  }
  for(const group of groups.values()){
    group.normal.normalize();for(const i of group.indices)normals.setXYZ(i,group.normal.x,group.normal.y,group.normal.z);
  }
  return geometry;
}

export function roundedBank(shore,curve){
  const steps=12,count=shore.length,rows=[],positions=[],uvs=[],grassUvs=[],blend=[],indices=[];
  const widths=shore.map((_,i)=>.60+.065*Math.sin(i/count*Math.PI*5+.7)+.025*Math.sin(i/count*Math.PI*11));
  for(let i=0;i<count;i++){
    const tangent=curve.getTangent(i/(count-1)),row=[];
    for(let j=0;j<=steps;j++){
      const u=j/steps,distance=widths[i]*u;
      const point=new THREE.Vector3(shore[i].x+tangent.z*distance,.06+.32*smooth(u),shore[i].z-tangent.x*distance);
      if(i===0)point.z=POND_HALF;if(i===count-1)point.x=POND_HALF;
      row.push(point);positions.push(...point.toArray());
      uvs.push((point.x+POND_HALF)/3,(POND_HALF-point.z)/3);grassUvs.push((point.x+POND_HALF)/8,(POND_HALF-point.z)/8);
      const transition=THREE.MathUtils.clamp((u-.50-.035*Math.sin(i*.12))/.39,0,1);blend.push(smooth(transition));
      if(i<count-1&&j<steps){const k=i*(steps+1)+j;indices.push(k,k+steps+1,k+1,k+1,k+steps+1,k+steps+2);}
    }
    rows.push(row);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('grassUv',new THREE.Float32BufferAttribute(grassUvs,2));
  geometry.setAttribute('grassBlend',new THREE.Float32BufferAttribute(blend,1));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  // The crest meets the level meadow with the same normal on both meshes.
  for(let i=0;i<count;i++)geometry.attributes.normal.setXYZ(i*(steps+1)+steps,0,1,0);

  const crest=rows.map(row=>row[steps]);
  const rim=[new THREE.Vector3(-POND_HALF,.38,POND_HALF),...rows[0].slice().reverse(),...shore.slice(1).map(p=>new THREE.Vector3(p.x,.06,p.z)),...rows.at(-1).slice(1),new THREE.Vector3(POND_HALF,.38,-POND_HALF),new THREE.Vector3(-POND_HALF,.38,-POND_HALF)];
  const wallPositions=[];
  for(let i=0;i<rim.length;i++){
    const a=rim[i],b=rim[(i+1)%rim.length];
    const bottomA=[a.x,-4.16,a.z],bottomB=[b.x,-4.16,b.z];
    wallPositions.push(...a.toArray(),...bottomA,...b.toArray(),...b.toArray(),...bottomA,...bottomB);
  }
  const walls=new THREE.BufferGeometry();walls.setAttribute('position',new THREE.Float32BufferAttribute(wallPositions,3));walls.computeVertexNormals();

  function heightAt(x,z){
    let nearest=Infinity,distance=0,width=widths[0];
    for(let i=0;i<count-1;i++){
      const a=shore[i],b=shore[i+1],dx=b.x-a.x,dz=b.z-a.z,lengthSq=dx*dx+dz*dz;
      const t=THREE.MathUtils.clamp(((x-a.x)*dx+(z-a.z)*dz)/lengthSq,0,1);
      const px=x-a.x-dx*t,pz=z-a.z-dz*t,squared=px*px+pz*pz;
      if(squared<nearest){nearest=squared;distance=(px*dz-pz*dx)/Math.sqrt(lengthSq);width=THREE.MathUtils.lerp(widths[i],widths[i+1],t);}
    }
    return .06+.32*smooth(THREE.MathUtils.clamp(distance/width,0,1));
  }
  return {geometry,walls,crest,heightAt};
}

export function bankMaterial(sandMap,grassMap){
  const material=new THREE.MeshStandardMaterial({map:sandMap,roughness:1});
  material.onBeforeCompile=shader=>{
    shader.uniforms.uBankGrass={value:grassMap};
    shader.vertexShader='attribute vec2 grassUv;attribute float grassBlend;varying vec2 vGrassUv;varying float vGrassBlend;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvGrassUv=grassUv;vGrassBlend=grassBlend;');
    shader.fragmentShader='uniform sampler2D uBankGrass;varying vec2 vGrassUv;varying float vGrassBlend;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','diffuseColor *= mix(texture2D(map,vMapUv),texture2D(uBankGrass,vGrassUv),vGrassBlend);');
  };
  return material;
}
