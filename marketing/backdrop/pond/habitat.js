import * as THREE from '../vendor/three.module.min.js';
import { buildFoliage } from './foliage.js';
import { roundedRockGeometry, roundedBank, bankMaterial } from './landforms.js';
import { POND_SIDE, POND_HALF, layoutZ } from './dimensions.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;
const noiseGLSL = `float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}`;

function shape(points) {
  return new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)));
}
function extrude(points, height) {
  const g = new THREE.ExtrudeGeometry(shape(points), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 12,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}
function flat(points) {
  const g = new THREE.ShapeGeometry(shape(points));
  g.rotateX(-Math.PI / 2);
  return g;
}
function roundedRectangle(w, h, r) {
  const s = new THREE.Shape(),
    x = -w / 2,
    y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function foundationSlab(w, d, h) {
  const g = new THREE.ExtrudeGeometry(roundedRectangle(w, d, 0.2), {
    depth: h,
    bevelEnabled: true,
    bevelSize: 0.025,
    bevelThickness: 0.025,
    bevelSegments: 2,
    curveSegments: 8,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}
// Bake world-scale UVs before batching so separate terrain sections line up.
function terrainUV(geometry, offset, tileSize) {
  const p = geometry.attributes.position,
    n = geometry.attributes.normal,
    uv = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + offset[0],
      y = p.getY(i) + offset[1],
      z = p.getZ(i) + offset[2];
    const nx = n.getX(i),
      ny = n.getY(i),
      nz = n.getZ(i);
    if (Math.abs(ny) > 0.6) {
      uv.push((x + POND_HALF) / tileSize, (POND_HALF - z) / tileSize);
      continue;
    }
    // Unwrap the four vertical faces continuously around the cut soil block.
    const around =
      Math.abs(nx) > Math.abs(nz)
        ? nx > 0
          ? POND_SIDE + POND_HALF - z
          : 3 * POND_SIDE + z + POND_HALF
        : nz > 0
          ? x + POND_HALF
          : 2 * POND_SIDE + POND_HALF - x;
    uv.push(around / tileSize, (y + 4.16) / tileSize);
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

export function buildHabitat({ world, mesh, material, rand, timeUniform }) {
  const loader = new THREE.TextureLoader(),
    terrainTextures = [],
    textureLoads = [];
  function loadTerrainTexture(name, version = 1) {
    let resolve, reject;
    textureLoads.push(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const texture = loader.load(
      new URL(`./textures/${name}-albedo-v${version}.png`, import.meta.url).href,
      resolve,
      undefined,
      () => reject(new Error(`Unable to load the ${name} terrain texture.`)),
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    terrainTextures.push(texture);
    return texture;
  }
  const soilMap = loadTerrainTexture('soil', 2),
    grassMap = loadTerrainTexture('grass', 2),
    sandMap = loadTerrainTexture('sand'),
    rockMap = loadTerrainTexture('rock');
  const clay = new THREE.MeshStandardMaterial({ map: soilMap, roughness: 1 });
  const grass = new THREE.MeshStandardMaterial({ map: grassMap, roughness: 1 });
  clay.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vSoil;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvSoil=(modelMatrix*vec4(position,1.)).xyz;',
    );
    shader.fragmentShader = 'varying vec3 vSoil;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      if(abs(vSoil.x)<${POND_HALF - 0.005}&&abs(vSoil.z)<${POND_HALF - 0.005}&&vSoil.y<.05){float depth=1.-exp(-abs(vSoil.y)*1.8);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.024,.29,.24),depth*.92);}
    `,
    );
  };
  const shoreCurve = new THREE.CatmullRomCurve3(
    [
      V(-1.9, 0, 4),
      V(-2.0, 0, 3.45),
      V(-2.52, 0, 2.92),
      V(-2.73, 0, 2.32),
      V(-2.64, 0, 1.7),
      V(-2.86, 0, 1.05),
      V(-2.71, 0, 0.4),
      V(-2.85, 0, -0.18),
      V(-2.57, 0, -0.83),
      V(-1.96, 0, -1.45),
      V(-1.1, 0, -1.82),
      V(-0.32, 0, -2.14),
      V(0.5, 0, -2.24),
      V(1.22, 0, -2.53),
      V(2.03, 0, -2.35),
      V(2.76, 0, -2.58),
      V(3.46, 0, -2.69),
      V(4.4, 0, -2.5),
    ].map(p => V(p.x, p.y, layoutZ(p.z))),
  );
  const shore = shoreCurve.getPoints(112);
  const landPoints = edge => [
    V(-POND_HALF, 0, POND_HALF),
    ...edge,
    V(POND_HALF, 0, -POND_HALF),
    V(-POND_HALF, 0, -POND_HALF),
  ];
  const bank = roundedBank(shore, shoreCurve),
    green = landPoints(bank.crest);
  const water = [...shore, V(POND_HALF, 0, POND_HALF)];

  // A continuous curved bank replaces the stacked soil, sand, and turf ledges.
  mesh(terrainUV(extrude(water, 0.88), [0, -4.16, 0], 8.8), clay, [0, -4.16, 0]);
  mesh(terrainUV(bank.walls, [0, 0, 0], 8.8), clay);
  mesh(bank.geometry, bankMaterial(sandMap, grassMap));
  mesh(terrainUV(flat(green), [0, 0.38, 0], 8), grass, [0, 0.38, 0]);

  // Double the foundation's overall height, keeping the thin cap and metal trim.
  // The top stays at -4.16; the beveled bottom now reaches -5.51.
  mesh(
    foundationSlab(POND_SIDE + 0.4, POND_SIDE + 0.4, 1.115),
    material(0x735840, 0.78),
    [0, -5.485, 0],
  );
  mesh(
    foundationSlab(POND_SIDE + 0.42, POND_SIDE + 0.42, 0.07),
    material(0xb2a078, 0.48, 0.28),
    [0, -4.345, 0],
  );
  mesh(
    foundationSlab(POND_SIDE + 0.26, POND_SIDE + 0.26, 0.1),
    material(0xc8b794, 0.85),
    [0, -4.26, 0],
  );
  const plaqueY = -4.9275,
    plaqueZ = POND_HALF + 0.234;
  const plaqueFrame = new THREE.ExtrudeGeometry(roundedRectangle(1.94, 0.31, 0.035), {
    depth: 0.018,
    bevelEnabled: true,
    bevelSize: 0.009,
    bevelThickness: 0.006,
    bevelSegments: 2,
    curveSegments: 6,
  });
  mesh(plaqueFrame, material(0xaaa079, 0.4, 0.55), [2.65, plaqueY, plaqueZ], world, false);
  const plaqueCanvas = document.createElement('canvas');
  plaqueCanvas.width = 1024;
  plaqueCanvas.height = 144;
  const plaqueContext = plaqueCanvas.getContext('2d');
  plaqueContext.fillStyle = '#3e4e40';
  plaqueContext.fillRect(0, 0, 1024, 144);
  plaqueContext.fillStyle = '#ded9b8';
  plaqueContext.font = '500 44px "Geist Mono", monospace';
  plaqueContext.textAlign = 'center';
  plaqueContext.textBaseline = 'middle';
  plaqueContext.fillText('BASSFISH / POND 002', 512, 75);
  const plaqueTexture = new THREE.CanvasTexture(plaqueCanvas);
  plaqueTexture.colorSpace = THREE.SRGBColorSpace;
  plaqueTexture.anisotropy = 4;
  mesh(
    new THREE.PlaneGeometry(1.87, 0.254),
    new THREE.MeshStandardMaterial({ map: plaqueTexture, roughness: 0.55, metalness: 0.15 }),
    [2.65, plaqueY, plaqueZ + 0.026],
    world,
    false,
  );
  const screwMat = material(0xc1b88d, 0.34, 0.55);
  for (const x of [1.762, 3.538]) {
    const screw = mesh(
      new THREE.SphereGeometry(0.023, 10, 7),
      screwMat,
      [x, plaqueY, plaqueZ + 0.033],
      world,
      false,
    );
    screw.scale.z = 0.32;
    mesh(
      new THREE.PlaneGeometry(0.023, 0.005),
      material(0x544f3e),
      [x, plaqueY, plaqueZ + 0.042],
      world,
      false,
    );
  }

  // A gently varied sand bed and its exposed golden rim.
  const bedHeightAt = (x, z) =>
    -3.24 + Math.sin(x * 1.3 + z * 0.8) * 0.065 + Math.sin(z * 2.2) * 0.035;
  const bedGeo = new THREE.PlaneGeometry(POND_SIDE, POND_SIDE, 65, 65);
  bedGeo.rotateX(-Math.PI / 2);
  const bp = bedGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i),
      z = bp.getZ(i);
    bp.setY(i, bedHeightAt(x, z));
  }
  bedGeo.computeVertexNormals();
  terrainUV(bedGeo, [0, 0, 0], 3.0);
  const bedMat = new THREE.MeshStandardMaterial({ map: sandMap, color: 0xc8d8bd, roughness: 1 });
  bedMat.onBeforeCompile = shader => {
    shader.uniforms.uPondTime = timeUniform;
    shader.vertexShader = 'varying vec3 vBed;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvBed=position;',
    );
    shader.fragmentShader =
      'varying vec3 vBed;uniform float uPondTime;\n' + noiseGLSL + '\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 q=vBed.xz*2.3+vec2(sin(vBed.z+uPondTime*.23),cos(vBed.x-uPondTime*.21))*.4;
      float caustic=pow(1.-abs(sin(q.x+sin(q.y))*cos(q.y+cos(q.x))),18.);diffuseColor.rgb+=caustic*.10;
    `,
    );
  };
  mesh(bedGeo, bedMat, [0, 0, 0]);

  // Alpha-cutout cards replace modeled blades, shrubs, flowers, and reeds.
  const foliage = buildFoliage(world, bank.heightAt);

  // Rounded silhouettes and shared smooth normals soften the painted rock surfaces.
  const rockMats = [0xffffff, 0xf1f3ec, 0xe2e9e4].map(
    color => new THREE.MeshStandardMaterial({ map: rockMap, color, roughness: 1 }),
  );
  const rockGeo = roundedRockGeometry(),
    pebbleGeo = roundedRockGeometry(18, 12);
  rockGeo.computeBoundingBox();
  pebbleGeo.computeBoundingBox();
  let rockCount = 0;
  function rock(x, y, z, sx, sy, sz, index = 0, authoredPosition = true) {
    if (authoredPosition) z = layoutZ(z);
    const large = Math.max(sx, sy, sz) > 0.3,
      size = large ? 0.72 : 0.9;
    sx *= size;
    sy *= size;
    sz *= size;
    const geometry = large ? rockGeo : pebbleGeo,
      bounds = geometry.boundingBox;
    const ground = y > 0.2 ? bank.heightAt(x, z) : bedHeightAt(x, z);
    // Bury the lower third of the rounded geometry, using the actual bank or
    // sand height so small stones cannot hover over a dip in the terrain.
    const centerY = ground - (bounds.min.y + (bounds.max.y - bounds.min.y) * 0.35) * sy;
    const r = mesh(geometry, rockMats[index % 3], [x, centerY, z]);
    r.scale.set(sx, sy, sz);
    r.rotation.y = rand() * TAU;
    rockCount++;
    return r;
  }
  rock(-2.94, 0.38, -3.05, 1.1, 1.15, 0.95);
  rock(-1.61, 0.38, -3.0, 0.46, 0.68, 0.42, 1);
  rock(-3.79, 0.35, 0.62, 0.62, 0.74, 0.5);
  rock(-2.62, 0.29, 2.55, 0.48, 0.55, 0.43, 1);
  rock(3.45, -3.13, 1.6, 0.65, 0.8, 0.52);
  rock(0.9, -3.2, 3.62, 0.38, 0.36, 0.32, 1);
  rock(-0.65, -3.18, 3.53, 0.42, 0.43, 0.33, 2);
  rock(2.75, -3.16, 3.11, 0.22, 0.22, 0.28);
  rock(3.78, 0.24, -2.82, 0.24, 0.43, 0.25, 1);
  for (let i = 0; i < 25; i++) {
    const shoreIndex = Math.floor(rand() * shore.length),
      p = shore[shoreIndex],
      t = shoreCurve.getTangent(shoreIndex / (shore.length - 1));
    rand(); // Preserve the established scatter while using the local bank direction.
    if (i < 14)
      rock(
        p.x + t.z * 0.16,
        0.24,
        p.z - t.x * 0.16,
        0.045 + rand() * 0.08,
        0.055 + rand() * 0.07,
        0.06 + rand() * 0.09,
        i,
        false,
      );
    else
      rock(
        -1.3 + rand() * 5.3,
        -3.16,
        0.2 + rand() * 3.65,
        0.08 + rand() * 0.09,
        0.07 + rand() * 0.08,
        0.08 + rand() * 0.08,
        i,
      );
  }
  // A fallen branch and scattered stones occupy the deep section.
  function tube(points, radius, mat) {
    const c = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => V(x, y, layoutZ(z))));
    return mesh(new THREE.TubeGeometry(c, 24, radius, 7, false), mat);
  }
  const logMat = material(0x465d45, 1);
  tube(
    [
      [-1.06, -2.89, 3.31],
      [-0.3, -3.0, 3.22],
      [0.6, -3.06, 2.98],
      [1.32, -3.08, 2.72],
    ],
    0.16,
    logMat,
  );
  tube(
    [
      [0.01, -3.0, 3.17],
      [-0.25, -2.73, 2.86],
      [-0.3, -2.44, 2.68],
    ],
    0.071,
    logMat,
  );
  tube(
    [
      [0.5, -3.04, 3.02],
      [0.75, -2.91, 3.27],
      [1.0, -2.84, 3.44],
    ],
    0.05,
    logMat,
  );

  // Copper is mostly buried: only two small contacts and moving light remain visible.
  const copper = material(0x8e784b, 0.6, 0.25),
    nodeGlow = new THREE.MeshStandardMaterial({
      color: 0xa6c9a0,
      emissive: 0x70b99a,
      emissiveIntensity: 0.35,
      roughness: 0.6,
    });
  for (const [x, z] of [
    [0.2, 3.35],
    [3.24, 2.6],
  ]) {
    mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.035, 12), copper, [x, -3.12, layoutZ(z)]);
    mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.009, 12),
      nodeGlow,
      [x, -3.096, layoutZ(z)],
      world,
      false,
    );
  }
  const route = new THREE.CatmullRomCurve3(
    [V(0.2, -3.17, 3.35), V(1.2, -3.19, 3.51), V(2.3, -3.18, 3.3), V(3.24, -3.17, 2.6)].map(p =>
      V(p.x, p.y, layoutZ(p.z)),
    ),
  );
  mesh(new THREE.TubeGeometry(route, 48, 0.009, 5, false), copper);
  const packet = mesh(new THREE.SphereGeometry(0.025, 8, 5), nodeGlow, [0, 0, 0], world, false);
  packet.userData.dynamic = true;

  // The coloured top is relatively opaque; the front face reveals the fish beneath it.
  const distanceSize = 128,
    distanceData = new Uint8Array(distanceSize * distanceSize);
  for (let j = 0; j < distanceSize; j++)
    for (let i = 0; i < distanceSize; i++) {
      const x = (i / (distanceSize - 1)) * POND_SIDE - POND_HALF,
        z = (j / (distanceSize - 1)) * POND_SIDE - POND_HALF;
      let d = 100;
      for (const p of shore) d = Math.min(d, Math.hypot(x - p.x, z - p.z));
      distanceData[j * distanceSize + i] = Math.min(255, Math.round((d / 3.1) * 255));
    }
  const depthTexture = new THREE.DataTexture(
    distanceData,
    distanceSize,
    distanceSize,
    THREE.RedFormat,
  );
  depthTexture.minFilter = THREE.LinearFilter;
  depthTexture.magFilter = THREE.LinearFilter;
  depthTexture.needsUpdate = true;
  const surfaceMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: timeUniform, uDepth: { value: depthTexture }, uSignalAge: { value: 20 } },
    vertexShader: `varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `
    varying vec3 vP;uniform float uTime;uniform float uSignalAge;uniform sampler2D uDepth;${noiseGLSL}
    void main(){vec2 p=vP.xz;float t=uTime*.12;float d=texture2D(uDepth,(p+vec2(${POND_HALF}))/vec2(${POND_SIDE})).r;
      float n=noise(p*1.3+vec2(t,-t*.65))*.65+noise(p*2.6-vec2(t*.8,t))*.35;
      float bands=floor((d*.7+n*.28)*8.)/8.;
      vec3 shallow=vec3(.17,.63,.45),deep=vec3(.006,.30,.41);
      vec3 col=mix(shallow,deep,smoothstep(.01,.58,bands));
      col*=.90+floor(n*5.)*.035;
      float glint=pow(max(0.,sin(p.x*3.7+sin(p.y*3.+t)*1.8+uTime*.2)),42.)*pow(max(0.,cos(p.y*8.-t)),22.);
      col+=glint*vec3(.25,.34,.29)*.7;
      float r=length(p-vec2(1.1,1.0));float ripple=exp(-pow((r-uSignalAge*1.55)/.027,2.))*exp(-uSignalAge*.8);
      col+=ripple*vec3(.25,.29,.20);
      gl_FragColor=vec4(col,.87);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  });
  const surface = mesh(flat(water), surfaceMat, [0, 0.06, 0], world, false);
  surface.renderOrder = 4;
  const faceMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: timeUniform },
    vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `
    varying vec2 vUv;uniform float uTime;void main(){float d=1.-vUv.y;vec3 c=mix(vec3(.018,.48,.48),vec3(.015,.39,.33),d);float ripple=sin(vUv.x*33.+uTime*.18+sin(vUv.y*10.))*.006;gl_FragColor=vec4(c,.46+d*.04+ripple);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  });
  const front = mesh(
    new THREE.PlaneGeometry(POND_HALF - shore[0].x, 3.3),
    faceMat,
    [(POND_HALF + shore[0].x) / 2, -1.59, POND_HALF + 0.005],
    world,
    false,
  );
  front.renderOrder = 5;
  const side = mesh(
    new THREE.PlaneGeometry(POND_HALF - shore.at(-1).z, 3.3),
    faceMat,
    [POND_HALF + 0.005, -1.59, (POND_HALF + shore.at(-1).z) / 2],
    world,
    false,
  );
  side.rotation.y = Math.PI / 2;
  side.renderOrder = 5;
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xe1f5e8, transparent: true, opacity: 0.9 });
  world.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        V(shore[0].x, 0.065, POND_HALF + 0.012),
        V(POND_HALF + 0.012, 0.065, POND_HALF + 0.012),
        V(POND_HALF + 0.012, 0.065, shore.at(-1).z),
      ]),
      edgeMat,
    ),
  );
  world.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        V(POND_HALF + 0.012, 0.065, POND_HALF + 0.012),
        V(POND_HALF + 0.012, -3.27, POND_HALF + 0.012),
      ]),
      edgeMat,
    ),
  );

  return {
    ready: Promise.all([...textureLoads, foliage.ready]),
    getStats: () => ({
      ...foliage.getStats(),
      terrainTextures: terrainTextures.length,
      texturedRocks: rockCount,
    }),
    update(time, signalAge) {
      surfaceMat.uniforms.uSignalAge.value = signalAge;
      foliage.update(time);
      nodeGlow.emissiveIntensity = 0.25 + Math.exp(-signalAge) * 1.1;
      packet.position.copy(route.getPoint((time * 0.075) % 1));
    },
    dispose() {
      foliage.dispose();
      depthTexture.dispose();
      plaqueTexture.dispose();
      terrainTextures.forEach(texture => texture.dispose());
    },
    shore,
  };
}
