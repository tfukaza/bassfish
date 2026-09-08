import * as THREE from '../vendor/three.module.min.js';

export function buildBass({ world, timeUniform }) {
  const textures = [],
    loads = [];
  const loader = new THREE.TextureLoader();
  function texture(name, version = 1) {
    let resolve, reject;
    loads.push(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const map = loader.load(
      new URL(`./fish/${name}-v${version}.png`, import.meta.url).href,
      resolve,
      undefined,
      () => reject(new Error(`Unable to load the ${name} fish texture.`)),
    );
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    textures.push(map);
    return map;
  }
  const bodyMap = texture('bass-body', 2),
    finMap = texture('bass-fins');
  function paintedMaterial(map, phase) {
    const mat = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, toneMapped: false });
    // One deformation for body and fins keeps every attachment together while swimming.
    mat.onBeforeCompile = shader => {
      shader.uniforms.uPondTime = timeUniform;
      shader.vertexShader = 'uniform float uPondTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float aft=1.-smoothstep(-1.30,.35,position.x);
        transformed.z+=sin(position.x*3.-uPondTime*3.3+${phase.toFixed(3)})*.12*aft*aft;
      `,
      );
    };
    mat.customProgramCacheKey = () => `painted-bass-${phase}`;
    return mat;
  }
  function makeBass(scale, phase) {
    const fish = new THREE.Group();
    fish.userData.dynamic = true;
    fish.name = 'textured-bass';
    fish.scale.setScalar(scale);
    world.add(fish);
    const bodyMaterial = paintedMaterial(bodyMap, phase),
      finMaterial = paintedMaterial(finMap, phase);
    function mesh(geometry, material) {
      const item = new THREE.Mesh(geometry, material);
      fish.add(item);
      return item;
    }
    // A deep shoulder, narrow tail wrist and blunt forehead give the silhouette
    // the proportions of a largemouth bass. The existing flank artwork stays in UV space.
    const profiles = [
      [-1.43, 0.001, 0.001],
      [-1.36, 0.075, 0.043],
      [-1.14, 0.145, 0.083],
      [-0.84, 0.265, 0.16],
      [-0.47, 0.385, 0.233],
      [-0.03, 0.425, 0.27],
      [0.34, 0.4, 0.285],
      [0.67, 0.345, 0.25],
      [0.89, 0.275, 0.202],
      [1.04, 0.21, 0.142],
      [1.15, 0.15, 0.09],
      [1.21, 0.085, 0.053],
      [1.235, 0.001, 0.001],
    ];
    const curve = new THREE.CatmullRomCurve3(profiles.map(p => new THREE.Vector3(...p)));
    const positions = [],
      uvs = [],
      indices = [],
      rings = 80,
      sides = 32;
    const headLift = x => 0.048 * THREE.MathUtils.smoothstep(x, 0.65, 1.22);
    const hinge = new THREE.Vector3(0.48, -0.16, 0);
    const seam = x => hinge.y + (x - hinge.x) * 0.23;
    for (let i = 0; i <= rings; i++)
      for (let j = 0; j <= sides; j++) {
        const p = curve.getPoint(i / rings),
          angle = (j / sides) * Math.PI * 2;
        positions.push(p.x, Math.cos(angle) * p.y + headLift(p.x), Math.sin(angle) * p.z);
        // Mirror the painted flank; keep the eye and gill plate above the mouth hinge.
        uvs.push(Math.min(1, (p.x + 1.43) / 2.665), (Math.cos(angle) + 1) / 2);
        if (i < rings && j < sides) {
          const k = i * (sides + 1) + j;
          indices.push(k, k + 1, k + sides + 1, k + 1, k + sides + 2, k + sides + 1);
        }
      }
    // Split the actual head surface along its mouth seam. Opening the lower patch
    // bends into the throat at the hinge, without a floating jaw or overlapping snout.
    function clip(polygon, distance) {
      const result = [];
      polygon.forEach((a, i) => {
        const b = polygon[(i + 1) % polygon.length],
          da = distance(a),
          db = distance(b);
        if (da >= 0) result.push(a);
        if (da < 0 !== db < 0) {
          const t = da / (da - db);
          result.push(a.map((v, k) => v + (b[k] - v) * t));
        }
      });
      return result;
    }
    const upper = [],
      lower = [];
    function triangles(polygon, out) {
      for (let i = 1; i < polygon.length - 1; i++)
        out.push(...polygon[0], ...polygon[i], ...polygon[i + 1]);
    }
    for (let i = 0; i < indices.length; i += 3) {
      const tri = indices
        .slice(i, i + 3)
        .map(k => [...positions.slice(k * 3, k * 3 + 3), ...uvs.slice(k * 2, k * 2 + 2)]);
      triangles(
        clip(tri, v => hinge.x - v[0]),
        upper,
      );
      const front = clip(tri, v => v[0] - hinge.x);
      triangles(
        clip(front, v => v[1] - seam(v[0])),
        upper,
      );
      triangles(
        clip(front, v => seam(v[0]) - v[1]),
        lower,
      );
    }
    function surface(data) {
      const position = [],
        uv = [];
      for (let i = 0; i < data.length; i += 5) {
        position.push(...data.slice(i, i + 3));
        uv.push(...data.slice(i + 3, i + 5));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geometry.computeVertexNormals();
      return geometry;
    }
    mesh(surface(upper), bodyMaterial);
    const jawGeometry = surface(lower),
      jaw = mesh(jawGeometry, bodyMaterial);
    jaw.name = 'articulated-lower-jaw';
    const jawRest = jawGeometry.attributes.position.array.slice();
    jawGeometry.attributes.position.setUsage(THREE.DynamicDrawUsage);

    // The cut's interior is a shallow dark mouth, with an attached floor and cheek
    // membranes. These surfaces stay hidden in the closed pose.
    const mouthShape = [];
    for (let i = 0; i <= 160; i++) {
      const p = curve.getPoint(i / 160);
      if (p.x < hinge.x) continue;
      const c = (seam(p.x) - headLift(p.x)) / p.y;
      if (Math.abs(c) < 1) mouthShape.push([p.x, seam(p.x), p.z * Math.sqrt(1 - c * c)]);
    }
    const inside = [],
      insideJaw = [];
    function innerTri(a, b, c, flags) {
      inside.push(...a, ...b, ...c);
      insideJaw.push(...flags);
    }
    for (let i = 0; i < mouthShape.length - 1; i++) {
      const [x, y, z] = mouthShape[i],
        [nx, ny, nz] = mouthShape[i + 1];
      const a = [x, y, -z],
        b = [x, y, z],
        c = [nx, ny, -nz],
        d = [nx, ny, nz];
      innerTri(a, b, c, [0, 0, 0]);
      innerTri(b, d, c, [0, 0, 0]);
      innerTri(a, c, b, [1, 1, 1]);
      innerTri(b, c, d, [1, 1, 1]);
      for (const [p, q] of [
        [a, c],
        [b, d],
      ]) {
        innerTri(p, q, p, [0, 0, 1]);
        innerTri(q, q, p, [0, 1, 1]);
      }
    }
    const interiorGeometry = new THREE.BufferGeometry();
    interiorGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(inside, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const mouthInterior = mesh(
      interiorGeometry,
      new THREE.MeshBasicMaterial({ color: 0x29301e, side: THREE.DoubleSide, toneMapped: false }),
    );
    mouthInterior.name = 'mouth-interior';
    mouthInterior.visible = false;
    // A narrow, olive upper lip makes the large mouth readable in the resting pose.
    const lipMaterial = new THREE.MeshBasicMaterial({ color: 0x687346, toneMapped: false });
    for (const side of [-1, 1]) {
      const lip = mouthShape
        .filter(p => p[0] > 0.57)
        .map(([x, y, z]) => new THREE.Vector3(x, y, z * side));
      mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lip), 32, 0.009, 5, false),
        lipMaterial,
      );
    }
    const upperLip = new THREE.Vector3(1.22, seam(1.22), 0),
      mouthPoint = upperLip.clone();
    let mouthAmount = -1;
    function lowerPoint(x, y, z, amount) {
      const angle = -amount * 0.48 * THREE.MathUtils.smoothstep(x, hinge.x, 0.75),
        c = Math.cos(angle),
        s = Math.sin(angle);
      return [
        hinge.x + (x - hinge.x) * c - (y - hinge.y) * s,
        hinge.y + (x - hinge.x) * s + (y - hinge.y) * c,
        z,
      ];
    }
    function setMouthOpen(value) {
      const amount = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
      if (amount === mouthAmount) return;
      mouthAmount = amount;
      fish.userData.mouthOpen = amount;
      const attribute = jawGeometry.attributes.position;
      for (let i = 0; i < jawRest.length; i += 3)
        attribute.setXYZ(i / 3, ...lowerPoint(jawRest[i], jawRest[i + 1], jawRest[i + 2], amount));
      attribute.needsUpdate = true;
      const inner = interiorGeometry.attributes.position;
      for (let i = 0; i < inside.length; i += 3)
        inner.setXYZ(
          i / 3,
          ...(insideJaw[i / 3]
            ? lowerPoint(inside[i], inside[i + 1], inside[i + 2], amount)
            : inside.slice(i, i + 3)),
        );
      inner.needsUpdate = true;
      mouthInterior.visible = amount > 0.005;
      mouthPoint.fromArray(lowerPoint(upperLip.x, upperLip.y, 0, amount)).lerp(upperLip, 0.5);
    }
    setMouthOpen(0);

    function fin(points, root) {
      const positions = [],
        uvs = [];
      const origin = new THREE.Vector3(...root),
        outer = points.map(p => new THREE.Vector3(...p).sub(origin));
      const across = outer[0].clone().sub(outer.at(-1)).normalize();
      const normal = outer[0].clone().cross(outer.at(-1)).normalize();
      const outward = normal.cross(across).normalize();
      if (outer.reduce((sum, p) => sum + p.dot(outward), 0) < 0) outward.negate();
      const width = 2 * Math.max(...outer.map(p => Math.abs(p.dot(across))));
      const height = Math.max(...outer.map(p => p.dot(outward)));
      const mapped = outer.map(p => [0.5 + p.dot(across) / width, p.dot(outward) / height]);
      for (let i = 0; i < points.length - 1; i++) {
        positions.push(...root, ...points[i], ...points[i + 1]);
        // A planar projection preserves straight fin rays across triangle boundaries.
        uvs.push(0.5, 0, ...mapped[i], ...mapped[i + 1]);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.computeVertexNormals();
      return mesh(geometry, finMaterial);
    }
    fin(
      [
        [-1.3, 0.075, 0],
        [-1.92, 0.4, 0],
        [-1.87, 0.18, 0],
        [-1.83, 0, 0],
        [-1.87, -0.18, 0],
        [-1.92, -0.4, 0],
        [-1.3, -0.075, 0],
      ],
      [-1.32, 0, 0],
    );
    fin(
      [
        [0.45, 0.35, 0],
        [0.23, 0.59, 0],
        [0.13, 0.44, 0],
        [0.01, 0.62, 0],
        [-0.1, 0.44, 0],
        [-0.24, 0.58, 0],
        [-0.33, 0.42, 0],
        [-0.52, 0.49, 0],
        [-0.69, 0.53, 0],
        [-0.86, 0.44, 0],
        [-1.05, 0.22, 0],
      ],
      [-0.36, 0.3, 0],
    );
    fin(
      [
        [-0.4, -0.32, 0],
        [-0.58, -0.57, 0],
        [-0.86, -0.53, 0],
        [-1.03, -0.21, 0],
      ],
      [-0.7, -0.27, 0],
    );
    for (const side of [-1, 1]) {
      fin(
        [
          [0.47, -0.035, 0.24 * side],
          [0.1, -0.31, 0.41 * side],
          [-0.22, -0.19, 0.24 * side],
        ],
        [0.42, -0.02, 0.22 * side],
      );
      fin(
        [
          [0.2, -0.29, 0.15 * side],
          [-0.01, -0.58, 0.28 * side],
          [-0.24, -0.35, 0.16 * side],
        ],
        [0.07, -0.28, 0.15 * side],
      );
    }
    return { fish, phase, setMouthOpen, mouthPoint };
  }
  const fishes = [makeBass(0.94, 1.05), makeBass(0.47, 3.2)];
  return {
    fishes,
    ready: Promise.all(loads),
    getStats: () => ({ texturedBass: fishes.length, fishTextures: textures.length }),
    // Geometry and materials belong to the scene's shared disposal pass.
    dispose: () => textures.forEach(map => map.dispose()),
  };
}
