// Tiny canvas text sprites. Redraw only when the text changes (cheap).
import * as THREE from 'three';

export interface TextSprite {
  sprite: THREE.Sprite;
  set: (text: string, color?: string) => void;
}

export function makeTextSprite(scale = 1): TextSprite {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 48;
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, fog: false, depthTest: false, transparent: true }));
  sprite.scale.set(0.9 * scale, 0.34 * scale, 1);
  sprite.renderOrder = 997;
  let last = '';
  return {
    sprite,
    set: (text: string, color = '#fff') => {
      const key = `${color}|${text}`;
      if (key === last) return;
      last = key;
      g.clearRect(0, 0, 128, 48);
      g.font = 'bold 30px monospace';
      g.textAlign = 'center';
      g.fillStyle = color;
      g.fillText(text.slice(0, 9), 64, 34);
      tex.needsUpdate = true;
    },
  };
}

export function hpColor(hp: number, max: number): string {
  const f = hp / max;
  if (f > 0.5) return '#5d5';
  if (f > 0.25) return '#dd5';
  return '#f55';
}

// Between-rounds gun picker (shared by solo + LAN presenters).
export function paintLoadout(show: boolean, primaryId: string, secondaryId: string): void {
  const el = document.getElementById('loadout');
  if (!el) return;
  el.style.display = show ? 'block' : 'none';
  if (!show) return;
  el.querySelectorAll<HTMLButtonElement>('button[data-pri]').forEach((b) => {
    b.style.border = ['ar', 'smg', 'shotgun'][Number(b.dataset.pri)] === primaryId ? '2px solid #ffd34d' : '';
  });
  el.querySelectorAll<HTMLButtonElement>('button[data-sec]').forEach((b) => {
    b.style.border = ['pistol', 'machinepistol'][Number(b.dataset.sec)] === secondaryId ? '2px solid #ffd34d' : '';
  });
}

// Objective beacon: diamond + letter, visible through walls, both teams see it.
export interface SiteBeacon {
  group: THREE.Group;
  set: (x: number, y: number, z: number, color: number) => void;
  tick: (dt: number) => void;
}

export function makeSiteBeacon(letter: string): SiteBeacon {
  const group = new THREE.Group();
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.3),
    new THREE.MeshBasicMaterial({ color: 0xffd34d, fog: false, depthTest: false, transparent: true, opacity: 0.95 }));
  gem.position.y = 2.8;
  gem.renderOrder = 996;
  const tag = makeTextSprite(1.4);
  tag.set(letter, '#ffd34d');
  tag.sprite.position.y = 3.6;
  group.add(gem, tag.sprite);
  group.visible = false;
  let spin = 0;
  return {
    group,
    set: (x, y, z, color) => {
      group.position.set(x, y, z);
      (gem.material as THREE.MeshBasicMaterial).color.setHex(color);
      group.visible = true;
    },
    tick: (dt) => {
      spin += dt * 2;
      gem.rotation.y = spin;
      gem.position.y = 2.8 + Math.sin(spin * 1.5) * 0.15;
    },
  };
}
