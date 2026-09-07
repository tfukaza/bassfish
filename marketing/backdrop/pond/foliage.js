import * as THREE from '../vendor/three.module.min.js';
import { POND_HALF, layoutZ } from './dimensions.js';

// Original generated PNGs retain their alpha; every upright plant is one quad.
export function buildFoliage(world,groundHeight=()=>.38){
  const textures=[],plants=[],pads=[],loads=[];
  const loader=new THREE.TextureLoader();
  function frameArtwork(map){
    // Read alpha to frame the artwork with UVs; keep the generated PNG unchanged.
    const image=map.image,ratio=Math.min(1,512/Math.max(image.width,image.height));
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(image.width*ratio);canvas.height=Math.ceil(image.height*ratio);
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,canvas.width,canvas.height);
    const {width,height}=canvas,data=context.getImageData(0,0,width,height).data;
    let left=width,top=height,right=-1,bottom=-1,clear=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const alpha=data[(y*width+x)*4+3];if(alpha<4)clear++;
      if(alpha<64)continue;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    if(right<left||clear<16)throw new Error('Foliage must contain artwork on a transparent background.');
    left=Math.max(0,left-2);top=Math.max(0,top-2);right=Math.min(width,right+3);bottom=Math.min(height,bottom+3);
    map.offset.set(left/width,1-bottom/height);map.repeat.set((right-left)/width,(bottom-top)/height);
    map.userData.artAspect=(right-left)/(bottom-top);
  }
  function texture(name){
    let resolve,reject;
    loads.push(new Promise((yes,no)=>{resolve=yes;reject=no;}));
    const map=loader.load(new URL(`./foliage/${name}-v2.png`,import.meta.url).href,loaded=>{
      try{frameArtwork(loaded);resolve();}catch(error){reject(error);}
    },undefined,()=>reject(new Error(`Unable to load the ${name} foliage sprite.`)));
    map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=4;
    textures.push(map);return map;
  }
  function plantMaterial(name,color=0xffffff){
    // Alpha testing writes depth, so rocks and the cutaway water occlude leaves correctly.
    // Preserve the illustration's flat colors as the camera turns.
    const mat=new THREE.SpriteMaterial({map:texture(name),color,alphaTest:.18,transparent:false,toneMapped:false});
    return mat;
  }
  const grass=plantMaterial('bank-grass'),shrub=plantMaterial('bank-shrub'),flowers=plantMaterial('bank-flowers');
  const weeds=plantMaterial('water-plants'),cattails=plantMaterial('cattails');
  // Rotating a card must never put an underwater leaf outside the cutaway volume.
  weeds.clippingPlanes=[
    new THREE.Plane(new THREE.Vector3(-1,0,0),POND_HALF-.01),new THREE.Plane(new THREE.Vector3(1,0,0),POND_HALF-.01),
    new THREE.Plane(new THREE.Vector3(0,0,-1),POND_HALF-.01),new THREE.Plane(new THREE.Vector3(0,0,1),POND_HALF-.01),
    new THREE.Plane(new THREE.Vector3(0,-1,0),.052),new THREE.Plane(new THREE.Vector3(0,1,0),3.24),
  ];
  function plant(mat,x,y,z,w,h,phase=0){
    z=layoutZ(z);
    if(y>.3)y=groundHeight(x,z)+.004;
    const sprite=new THREE.Sprite(mat);sprite.name='painted-foliage';
    sprite.center.set(.5,.015);sprite.position.set(x,y,z);sprite.scale.set(w,h,1);
    sprite.userData.dynamic=true;world.add(sprite);
    plants.push({sprite,maxWidth:w,maxHeight:h,width:w,height:h,phase});return sprite;
  }

  // Overlapping groups form a fuller bank, with low flowers along the sandy edge.
  for(const [x,z,w,h] of [
    [-3.80,-3.48,1.64,1.78],[-4.01,1.10,1.18,1.23],[-3.38,2.55,.72,.77],
    [.95,-3.40,1.10,1.03],[3.42,-3.40,.82,.86],
    [-3.97,3.36,.46,.42],[-3.81,-.45,.49,.48],[-.28,-3.27,.46,.39],
    [2.32,-3.46,.47,.43],[-3.98,-2.67,.45,.44],
    [-3.76,-2.99,.73,.87],[-3.95,-1.13,.67,.69],[-3.57,.12,.57,.61],
    [-3.17,3.28,.72,.74],[-2.12,-3.60,.76,.84],[-.78,-2.79,.56,.58],
    [.15,-3.70,.67,.73],[1.72,-3.72,.64,.73],[3.84,-3.12,.64,.67],
  ])plant(grass,x,.383,z,w*1.25,h*1.25,x+z);
  for(const [x,z,w,h] of [
    [-3.69,-1.92,1.30,.98],[-3.83,1.80,1.14,.87],[-1.10,-3.46,.88,.70],
    [-2.91,-3.65,1.08,.82],[-3.75,2.98,.91,.67],[.33,-3.26,1.0,.73],[2.58,-3.54,.93,.72],
  ]){
    plant(shrub,x,.385,z,w*1.2,h*1.2,x);
  }
  for(const [x,z,w,h] of [
    [-3.19,-.91,.72,.50],[-1.92,-2.59,.79,.53],[-3.49,2.00,.56,.40],
    [-3.30,.79,.62,.43],[-2.88,3.55,.58,.41],[1.79,-3.05,.72,.47],
  ]){
    plant(flowers,x,.387,z,w*1.2,h*1.2,z);
  }
  const groundPlants=plants.length;
  for(const [x,z,w,h] of [
    [-1.08,3.33,1.05,1.68],[3.62,2.20,1.25,2.10],[3.35,-.39,1.74,2.92],[-1.91,1.89,.82,1.39],
    [-.18,.75,.76,1.14],[2.52,-.89,.85,1.53],
  ]){
    plant(weeds,x,-3.16,z,w*1.10,h*1.10,z+2);
  }
  plant(cattails,3.58,.052,-.84,1.63,2.30,3);

  const padMap=texture('lily-pad');
  const padMaterial=new THREE.MeshBasicMaterial({map:padMap,alphaTest:.5,side:THREE.DoubleSide,toneMapped:false});
  const padGeometry=new THREE.PlaneGeometry(1,1);padGeometry.rotateX(-Math.PI/2);
  for(const [x,z,r,angle] of [[2.55,-1.32,.59,.7],[1.47,-.44,.45,2.3],[2.29,.16,.52,3.2],[3.0,-.14,.62,1.6],[2.90,.99,.32,4.4]]){
    const pad=new THREE.Mesh(padGeometry,padMaterial);
    pad.name='painted-lily-pad';pad.userData.dynamic=true;pad.userData.radius=r;pad.position.set(x,.10,layoutZ(z));
    pad.scale.set(r*2,1,r*2);pad.rotation.y=angle;world.add(pad);pads.push(pad);
  }

  return {
    ready:Promise.all(loads).then(()=>{
      for(const plant of plants){
        const aspect=plant.sprite.material.map.userData.artAspect;
        plant.height=Math.min(plant.maxHeight,plant.maxWidth/aspect);plant.width=plant.height*aspect;
      }
      for(const pad of pads)pad.scale.x=pad.userData.radius*2*padMap.userData.artAspect;
    }),
    getStats(){return {billboards:plants.length,groundPlants,lilyPads:pads.length,foliageTextures:textures.length};},
    update(time){
      // Gentle movement is around each rooted anchor and follows simulation pause.
      for(const {sprite,width,height,phase} of plants){
        sprite.scale.x=width*(1+Math.sin(time*.65+phase)*.009);
        sprite.scale.y=height*(1+Math.sin(time*.53+phase)*.004);
      }
      pads.forEach((pad,i)=>{pad.position.y=.10+Math.sin(time*.6+i)*.007;pad.rotation.z=Math.sin(time*.35+i)*.006;});
    },
    // The scene owns material/geometry disposal; this module owns the image maps.
    dispose(){textures.forEach(map=>map.dispose());},
  };
}
