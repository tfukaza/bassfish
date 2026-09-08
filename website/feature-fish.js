import * as THREE from './backdrop/vendor/three.module.min.js';
import { buildBass } from './backdrop/pond/bass.js';

// One small, lazily mounted scene per visible demo. No independent animation loop.
export async function createFeatureFish(element) {
  const stage = element.querySelector('.demo-animation');
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0, 0);
  renderer.domElement.className = 'feature-fish-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene(),
    world = new THREE.Group(),
    timeUniform = { value: 0 };
  scene.add(world);
  const bass = buildBass({ world, timeUniform }),
    camera = new THREE.OrthographicCamera();
  camera.position.z = 1000;
  camera.near = 0.1;
  camera.far = 2000;
  const kind = element.dataset.demo;
  const bubbles = [];
  if (kind === 'team')
    for (let i = 0; i < 2; i++) {
      const bubble = document.createElement('div');
      bubble.className = 'fish-speech speech-dots';
      bubble.innerHTML = '<i></i><i></i><i></i>';
      bubble.hidden = true;
      stage.append(bubble);
      bubbles.push(bubble);
    }
  if (kind === 'mentions') bubbles.push(stage.querySelector('.here-message'));
  let tackle;
  if (kind === 'files') {
    tackle = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tackle.classList.add('fishing-tackle');
    tackle.innerHTML =
      '<path class="line fishing-line"/><g class="lure"><circle class="lure-ring" cy="-15" r="3"/><path class="lure-body" d="M0 -11 C12 -7 11 7 0 14 C-11 7 -12 -7 0 -11Z"/><path class="lure-flash" d="M0 -9 C7 -5 7 4 0 11 C1 2 -2 -3 0 -9Z"/><path class="lure-shine" d="M-4 -6 Q-7 1 -3 6"/><path class="hook" d="M0 14 v8 c0 9 11 9 11 0 l-3 3"/></g>';
    stage.prepend(tackle);
  }
  let lastTime = 0,
    disposed = false;
  const smooth = x => {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  };
  function draw(t) {
    if (disposed) return;
    lastTime = t;
    const w = stage.clientWidth,
      h = stage.clientHeight + 260;
    if (
      renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) ||
      renderer.domElement.height !== Math.round(h * renderer.getPixelRatio())
    )
      renderer.setSize(w, h, false);
    camera.left = -w / 2;
    camera.right = w / 2;
    camera.top = h / 2;
    camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
    const mouths = [],
      windows = [...stage.querySelectorAll('.glass-window')],
      rect = stage.getBoundingClientRect();
    const fileRect = windows[0].getBoundingClientRect();
    const lure = {
      x: fileRect.left - rect.left + fileRect.width / 2,
      y: fileRect.top - rect.top - 54,
    };
    const firstGrip = smooth((t - 1.1) / 1.1) * (1 - smooth((t - 5.9) / 0.8));
    const secondGrip = smooth((t - 6) / 1.1) * (1 - smooth((t - 10.5) / 0.8));
    const speak = [
      (t >= 1.2 && t < 2.8) || (t >= 7.5 && t < 9),
      (t >= 4.5 && t < 6.5) || (t >= 9 && t < 11.5),
    ];
    bass.fishes.forEach((entry, i) => {
      const { fish } = entry;
      const start = kind === 'team' ? (i ? 3 : 0) : kind === 'mentions' ? (i ? 9 : 3) : 0;
      const window = windows[Math.min(i, windows.length - 1)],
        r = window.getBoundingClientRect();
      const emerge = smooth((t - start) / 1.6),
        size = Math.min(w < 400 ? 140 : 205, w * 0.46);
      fish.visible = t >= start;
      fish.scale.setScalar(size / 3.1);
      // Rise from behind the opaque terminal edge, leaving the lower flank occluded.
      const x =
        kind === 'team'
          ? i
            ? r.right - rect.left - size * 0.75
            : r.left - rect.left + size * 0.75
          : r.left - rect.left + r.width * (i ? 0.76 : 0.25);
      const y = r.top - rect.top + 45 - emerge * 62;
      fish.position.set(x - w / 2, h / 2 - (y + 130), 0);

      const yaw = 0.42 + (1 - emerge) * 0.75;
      fish.rotation.set(0, i ? Math.PI - yaw : yaw, Math.PI / 4);
      let mouthOpen =
        kind === 'team' && speak[i]
          ? 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * 16))
          : kind === 'mentions' && i === 0 && t >= 9 && t < 11.5
            ? 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * 16))
            : 0;
      if (kind === 'files') {
        const grip = i ? secondGrip : firstGrip;
        // Open on approach, then close gently around the lure while holding the file turn.
        mouthOpen = grip > 0.94 ? 0.22 : Math.sin(grip * Math.PI) * 0.85;
      }
      entry.setMouthOpen?.(mouthOpen);
      fish.updateMatrixWorld(true);
      const lip = entry.mouthPoint?.clone() || new THREE.Vector3(1.06, 0.08, 0);
      let mouth = fish.localToWorld(lip);
      if (kind === 'files') {
        const grip = i ? secondGrip : firstGrip;
        const target = new THREE.Vector3(
          lure.x + (i ? 6 : -6) - w / 2,
          h / 2 - (lure.y + 5 + 130),
          mouth.z,
        );
        fish.position.add(target.sub(mouth).multiplyScalar(grip));
        fish.updateMatrixWorld(true);
        mouth = fish.localToWorld(entry.mouthPoint?.clone() || new THREE.Vector3(1.06, 0.08, 0));
      }
      mouths.push({ x: mouth.x + w / 2, y: h / 2 - mouth.y - 130 });
    });
    function speech(bubble, mouth, visible) {
      bubble.hidden = !visible;
      if (!visible) return;
      const half = bubble.offsetWidth / 2 + 6,
        x = Math.max(half, Math.min(w - half, mouth.x));
      bubble.style.left = `clamp(${half}px, ${x}px, calc(100% - ${half}px))`;
      bubble.style.top = `${mouth.y - 13}px`;
      bubble.style.setProperty(
        '--tail',
        `${Math.max(10, Math.min(bubble.offsetWidth - 15, mouth.x - x + bubble.offsetWidth / 2))}px`,
      );
    }
    if (kind === 'team') {
      speech(bubbles[0], mouths[0], (t >= 1.2 && t < 2.8) || (t >= 7.5 && t < 9));
      speech(bubbles[1], mouths[1], (t >= 4.5 && t < 6.5) || (t >= 9 && t < 11.5));
    }
    if (kind === 'mentions') speech(bubbles[0], mouths[0], t >= 9);
    if (tackle) {
      // A single lure stays centered; the fish move to it instead of the tackle changing owners.
      const drop = smooth(t / 1.1),
        y = -115 + (lure.y + 115) * drop;
      tackle.setAttribute('viewBox', `0 0 ${w} ${h}`);
      tackle.querySelector('.line').setAttribute('d', `M ${lure.x} 5 L ${lure.x} ${y + 130 - 18}`);
      tackle.querySelector('.lure').setAttribute('transform', `translate(${lure.x} ${y + 130})`);
      const owner = t < 6 ? 0 : 1;
      element.dataset.lureX = String(lure.x);
      element.dataset.bite = String(Math.max(firstGrip, secondGrip));
      element.dataset.hookOwner = t >= 10.5 ? 'none' : owner ? 'client-agent' : 'api-agent';
    }
    timeUniform.value = t;
    renderer.render(scene, camera);
    element.dataset.fishReady = 'true';
    element.dataset.fishTime = String(t);
  }
  const resize = new ResizeObserver(() => draw(lastTime));
  function dispose() {
    if (disposed) return;
    disposed = true;
    resize.disconnect();
    bubbles.filter(b => !b.classList.contains('here-message')).forEach(b => b.remove());
    tackle?.remove();
    scene.traverse(o => {
      o.geometry?.dispose();
      if (o.material) for (const m of [o.material].flat()) m.dispose();
    });
    bass.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
  try {
    await bass.ready;
    resize.observe(stage);
    return { draw, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
