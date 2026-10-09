// Gera os assets do boneco em Server/wwwroot/assets a partir das imagens em /Personagens.
// Uso (uma vez, ou quando as imagens mudarem):  npm i pngjs  &&  node tools/build-doll-assets.js
// Recorta as peças da folha "partida", reduz, e calcula a posição/pivô de cada peça
// (casando com a imagem do personagem inteiro) para montar o boneco no jogo.
const fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');

const SRC = path.join(__dirname, '..', 'Personagens');
const OUT = path.join(__dirname, '..', 'Server', 'wwwroot', 'assets');
const F = 0.4;              // redução dos recortes (resolução dos assets)
const TARGET_H = 48;        // altura do boneco no jogo (px do mundo)
const FIG_TOP = 32, FIG_BOT = 341; // altura do personagem inteiro nas imagens originais

// Caixas (x0,y0,x1,y1) de cada peça na folha, e onde/qual escala ela fica no personagem inteiro
// (resultado do casamento de imagens feito sobre os arquivos fornecidos).
const GENDERS = {
  // Homem (arte nova "homem png partido 2.png"): caixas apertadas em cada peça da folha; "at" = onde a caixa cai na
  // imagem do personagem inteiro ("homem png 2.png", 174x351, figura em y 16..335) e "s" = escala (casamento de imagens)
  m: { dir: 'Homem', sheet: 'homem png partido 2.png', figTop: 16, figBot: 335,
    head: { box: [40, 96, 169, 248], at: [7.5, 16], s: 0.96 },
    torso: { box: [221, 110, 334, 259], at: [28, 143], s: 0.76 },
    arm: { box: [414, 121, 461, 253], at: [23, 155], s: 0.81 },
    leg: { box: [546, 118, 611, 267], at: [54, 242], s: 0.62 } },
  f: { dir: 'Mulher', sheet: 'Mulher png partida.png', figTop: FIG_TOP, figBot: FIG_BOT,
    head: { box: [46, 46, 211, 236], at: [236, 32], s: 1.0 },
    torso: { box: [279, 111, 353, 256], at: [318, 151], s: 0.7 },
    arm: { box: [427, 124, 477, 247], at: [297, 165], s: 0.9 },
    leg: { box: [539, 123, 616, 268], at: [310, 211], s: 0.9 } },
};

const read = f => PNG.sync.read(fs.readFileSync(f));
const alphaAt = (p, x, y) => p.data[(y * p.width + x) * 4 + 3];

function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return -1;
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
const isGreen = (p, x, y) => {
  const i = (y * p.width + x) * 4; if (p.data[i + 3] < 128) return false;
  const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
  if (Math.max(r, g, b) - Math.min(r, g, b) < 70) return false; // cinza/preto não conta
  const h = hue(r, g, b); return h >= 100 && h <= 170;
};

// Aperta a caixa até a região opaca
function tightBox(p, [x0, y0, x1, y1]) {
  let a = 1e9, b = 1e9, c = -1, d = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
    if (alphaAt(p, x, y) > 20) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}

// Recorta e reduz (média de área, com alfa pré-multiplicado)
function cropScaled(p, [x0, y0, x1, y1], f) {
  const w = Math.max(1, Math.round((x1 - x0 + 1) * f)), h = Math.max(1, Math.round((y1 - y0 + 1) * f));
  const out = new PNG({ width: w, height: h });
  for (let oy = 0; oy < h; oy++) for (let ox = 0; ox < w; ox++) {
    const sx0 = x0 + ox / f, sx1 = x0 + (ox + 1) / f, sy0 = y0 + oy / f, sy1 = y0 + (oy + 1) / f;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const i = (y * p.width + x) * 4, al = p.data[i + 3];
      r += p.data[i] * al; g += p.data[i + 1] * al; b += p.data[i + 2] * al; a += al; n++;
    }
    const j = (oy * w + ox) * 4;
    if (a > 0) { out.data[j] = r / a; out.data[j + 1] = g / a; out.data[j + 2] = b / a; out.data[j + 3] = a / n; }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const layout = {};

for (const [g, G] of Object.entries(GENDERS)) {
  const sheet = read(path.join(SRC, G.dir, G.sheet));
  const k = TARGET_H / (G.figBot - G.figTop); // cada personagem tem a própria altura na imagem inteira
  const cy = (G.figTop + G.figBot) / 2;
  const cx = G.torso.at[0] + (G.torso.box[2] - G.torso.box[0] + 1) * G.torso.s / 2; // centro do corpo
  const parts = [];

  // Converte um ponto da folha (px) para coordenadas do jogo, usando a peça de referência
  const toGame = (ref, sx, sy) => ({
    x: (ref.at[0] + (sx - ref.box[0]) * ref.s - cx) * k,
    y: (ref.at[1] + (sy - ref.box[1]) * ref.s - cy) * k });

  // Define uma peça: caixa na folha, peça de referência (escala/posição) e pivô em px da folha
  const add = (id, ref, box, pivot) => {
    const tb = tightBox(sheet, box);
    const img = cropScaled(sheet, tb, F);
    fs.writeFileSync(path.join(OUT, `${g}_${id}.png`), PNG.sync.write(img));
    const pv = pivot(tb);
    const pos = toGame(ref, pv[0], pv[1]);
    parts.push({ id, file: `${g}_${id}.png`, x: +pos.x.toFixed(2), y: +pos.y.toFixed(2),
      ox: +((pv[0] - tb[0]) * F / img.width).toFixed(3), oy: +((pv[1] - tb[1]) * F / img.height).toFixed(3),
      scale: +(ref.s * k / F).toFixed(4) });
  };

  const meanX = (tb, y0, y1) => {
    let s = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = tb[0]; x <= tb[2]; x++) if (alphaAt(sheet, x, y) > 100) { s += x; n++; }
    return n ? s / n : (tb[0] + tb[2]) / 2;
  };
  const armPivot = tb => [meanX(tb, tb[1], tb[1] + 6), tb[1] + 12];
  // Pivô da cabeça = base do pescoço (parte mais baixa da PELE; o cabelo/rabo pode descer mais)
  const isSkin = (x, y) => {
    const i = (y * sheet.width + x) * 4; if (sheet.data[i + 3] < 128) return false;
    const r = sheet.data[i], g2 = sheet.data[i + 1], b = sheet.data[i + 2];
    if (Math.max(r, g2, b) - Math.min(r, g2, b) < 70) return false;
    const h = hue(r, g2, b); return h >= 10 && h <= 50;
  };
  const headPivot = tb => {
    let bottom = tb[1];
    for (let y = tb[1]; y <= tb[3]; y++) for (let x = tb[0]; x <= tb[2]; x++) if (isSkin(x, y)) bottom = y;
    let s = 0, n = 0;
    for (let y = bottom - 5; y <= bottom; y++) for (let x = tb[0]; x <= tb[2]; x++) if (isSkin(x, y)) { s += x; n++; }
    return [n ? s / n : (tb[0] + tb[2]) / 2, bottom - 1];
  };
  const center = tb => [(tb[0] + tb[2]) / 2, (tb[1] + tb[3]) / 2];

  // Ordem de desenho: de trás para frente
  add('armFar', G.arm, G.arm.box, armPivot);

  let shortsBox = null;
  if (g === 'm') {
    const legPivot = tb => [meanX(tb, tb[1], tb[1] + 6), tb[1] + 10];
    add('legFar', G.leg, G.leg.box, legPivot);
    add('legNear', G.leg, G.leg.box, legPivot);
  } else {
    // A peça das pernas da mulher tem shorts + duas pernas: separa em shorts (fixo) e duas pernas
    const tb = tightBox(sheet, G.leg.box);
    let hem = tb[1];
    for (let y = tb[1]; y <= tb[3]; y++) {
      let n = 0;
      for (let x = tb[0]; x <= tb[2]; x++) if (isGreen(sheet, x, y)) n++;
      if (n >= 3) hem = y;
    }
    // coluna do vão entre as pernas: o maior vão interno entre as linhas abaixo da barra do shorts
    let best = { len: 0, mid: (tb[0] + tb[2]) / 2 };
    for (let y = hem + 8; y <= tb[3] - 3; y++) {
      let lo = tb[2], hi = tb[0];
      for (let x = tb[0]; x <= tb[2]; x++) if (alphaAt(sheet, x, y) > 20) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      let run = 0, start = 0;
      for (let x = lo; x <= hi; x++) {
        if (alphaAt(sheet, x, y) <= 20) {
          if (!run) start = x;
          run++;
          if (run > best.len) best = { len: run, mid: start + run / 2 };
        } else run = 0;
      }
    }
    const split = Math.round(best.mid);
    console.log(`mulher: barra do shorts y=${hem}, vão em x=${split} (largura ${best.len}), caixa ${tb}`);
    const legPivot = t => [(t[0] + t[2]) / 2, t[1] + 6];
    const top = hem - 8; // as pernas começam um pouco acima da barra, escondidas pelo shorts
    add('legFar', G.leg, [tb[0], top, split - 1, tb[3]], legPivot);
    add('legNear', G.leg, [split, top, tb[2], tb[3]], legPivot);
    shortsBox = [tb[0], tb[1], tb[2], hem];
  }

  add('torso', G.torso, G.torso.box, center);
  if (shortsBox) add('shorts', G.leg, shortsBox, center);
  add('head', G.head, G.head.box, headPivot);
  add('armNear', G.arm, G.arm.box, armPivot);

  layout[g] = parts;
}
fs.writeFileSync(path.join(OUT, 'dolls.json'), JSON.stringify(layout, null, 1));
console.log('ok:', Object.keys(layout).map(g => g + ' ' + layout[g].length + ' peças').join(', '));
