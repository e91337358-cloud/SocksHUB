/* Рисует носки. Никаких картинок — только SVG, собранный на лету. */

const SOCK_PATH = 'M30 6 H70 V60 L92 74 A16 16 0 0 1 76 100 H46 A16 16 0 0 1 30 84 Z';

const PALETTES = [
  { base: '#d9534f', ink: '#ffe9c7', name: 'красный' },
  { base: '#2f6f4e', ink: '#e8f5ec', name: 'зелёный' },
  { base: '#2b4c8c', ink: '#dce8ff', name: 'синий' },
  { base: '#e0a32e', ink: '#4a3306', name: 'горчичный' },
  { base: '#7b4397', ink: '#f2e2ff', name: 'сливовый' },
  { base: '#1f1f22', ink: '#8e8e96', name: 'чёрный' },
  { base: '#f2efe6', ink: '#b9b2a0', name: 'белый' },
  { base: '#c96a4a', ink: '#ffe4d6', name: 'терракота' },
  { base: '#3aa8a0', ink: '#e4fffd', name: 'бирюзовый' },
  { base: '#b23a6d', ink: '#ffe0ee', name: 'фуксия' },
];

/* детерминированный рандом — один и тот же id даёт один и тот же носок */
function rng(seed) {
  let s = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

function patternFor(kind, p, r, uid) {
  switch (kind) {
    case 'stripes': {
      let out = '';
      const h = 7 + Math.round(r() * 5);
      for (let y = -10; y < 120; y += h * 2) {
        out += `<rect x="10" y="${y}" width="100" height="${h}" fill="${p.ink}" opacity=".85"/>`;
      }
      return out;
    }
    case 'dots': {
      let out = '';
      for (let y = 12; y < 104; y += 13) {
        for (let x = 22; x < 100; x += 13) {
          const off = (y / 13) % 2 ? 6 : 0;
          out += `<circle cx="${x + off}" cy="${y}" r="3" fill="${p.ink}" opacity=".9"/>`;
        }
      }
      return out;
    }
    case 'argyle': {
      let out = '';
      for (let y = 0; y < 120; y += 22) {
        for (let x = 10; x < 110; x += 22) {
          out += `<path d="M${x} ${y + 11} L${x + 11} ${y} L${x + 22} ${y + 11} L${x + 11} ${y + 22} Z"
                   fill="${p.ink}" opacity=".55"/>`;
        }
      }
      return out;
    }
    case 'zigzag': {
      let out = '';
      for (let y = 4; y < 120; y += 16) {
        let d = `M8 ${y}`;
        for (let x = 8; x < 110; x += 10) d += ` l5 -6 l5 6`;
        out += `<path d="${d}" fill="none" stroke="${p.ink}" stroke-width="3" opacity=".8"/>`;
      }
      return out;
    }
    case 'terry':
      return `<rect x="0" y="0" width="110" height="120" fill="url(#terry${uid})"/>`;
    default:
      return '';
  }
}

/**
 * @param {object} o  { id, pal, pattern, hole, cuff }
 * @param {number} size — сторона квадрата в px
 */
function sockSVG(o, size = 220) {
  const r = rng(o.id);
  const p = PALETTES[o.pal % PALETTES.length];
  const uid = 's' + String(o.id).replace(/\W/g, '');
  const rot = -14 + r() * 28;

  const hole = o.hole
    ? `<g>
         <ellipse cx="${o.hole.x}" cy="${o.hole.y}" rx="9" ry="7" fill="#0d0d10"/>
         <ellipse cx="${o.hole.x}" cy="${o.hole.y}" rx="9" ry="7" fill="none"
                  stroke="${p.ink}" stroke-width="2" stroke-dasharray="3 3" opacity=".7"/>
       </g>` : '';

  return `
<svg class="sock" viewBox="0 0 110 120" width="${size}" height="${size}" role="img" aria-label="носок">
  <defs>
    <clipPath id="clip${uid}"><path d="${SOCK_PATH}"/></clipPath>
    <linearGradient id="sh${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".55" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".28"/>
    </linearGradient>
    <pattern id="terry${uid}" width="6" height="6" patternUnits="userSpaceOnUse">
      <circle cx="3" cy="3" r="2.1" fill="${p.ink}" opacity=".35"/>
    </pattern>
  </defs>

  <g transform="rotate(${rot.toFixed(1)} 55 60)">
    <path d="${SOCK_PATH}" fill="#000" opacity=".35" transform="translate(3 5)"/>
    <g clip-path="url(#clip${uid})">
      <rect x="0" y="0" width="110" height="120" fill="${p.base}"/>
      ${patternFor(o.pattern, p, r, uid)}
      <rect x="0" y="0" width="110" height="120" fill="url(#sh${uid})"/>
      <rect x="20" y="${o.cuff ? 6 : -30}" width="70" height="16" fill="${p.ink}" opacity=".9"/>
      <path d="M62 74 Q78 80 88 96" fill="none" stroke="#000" stroke-width="2" opacity=".18"/>
      ${hole}
    </g>
    <path d="${SOCK_PATH}" fill="none" stroke="#000" stroke-width="2.5" opacity=".35"/>
  </g>
</svg>`;
}

function palName(i) { return PALETTES[i % PALETTES.length].name; }
function palOf(i) { return PALETTES[i % PALETTES.length]; }
