// Gera os assets da arena e do balão de chat em Server/wwwroot/assets a partir das imagens em /Personagens/background.
// Uso (uma vez, ou quando as imagens mudarem):  npm i pngjs  &&  node tools/build-arena-assets.js
//   Arena.jpg          -> fundo_arena.jpg (cópia)
//   Placa arena.png    -> placa_arena.png (sem margem, reduzida; se o fundo vier branco, ele é removido)
//   Placa floresta.png -> placa_floresta.png (idem)
//   Fundo Floresta.jpg, Fundo Floresta 2.jpg, Fundo Floresta 3.jpg -> fundo_floresta.jpg, fundo_floresta_2.jpg, fundo_floresta_3.jpg (cópias;
//     as três emendam entre si e formam a floresta grande; ao trocar as imagens, aumente FOREST_ART_VERSION no game.js)
//   Balao de texto.png -> balao.png + balao.json (pontas do pergaminho e margens do texto)
const fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');

const SRC = path.join(__dirname, '..', 'Personagens', 'background');
const OUT = path.join(__dirname, '..', 'Server', 'wwwroot', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const read = f => PNG.sync.read(fs.readFileSync(f));
const write = (png, name) => fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));

// Se a imagem não tem transparência real nos cantos (fundo branco), apaga o branco ligado às bordas
function keyOutWhiteBorder(p) {
  const a = (x, y) => p.data[(y * p.width + x) * 4 + 3];
  if (a(0, 0) < 10) return; // já é transparente
  const seen = new Uint8Array(p.width * p.height), stack = [];
  const white = i => p.data[i * 4] > 235 && p.data[i * 4 + 1] > 235 && p.data[i * 4 + 2] > 235;
  for (let x = 0; x < p.width; x++) { stack.push(x, p.width * (p.height - 1) + x); }
  for (let y = 0; y < p.height; y++) { stack.push(y * p.width, y * p.width + p.width - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || !white(i)) continue;
    seen[i] = 1; p.data[i * 4 + 3] = 0;
    const x = i % p.width, y = (i / p.width) | 0;
    if (x > 0) stack.push(i - 1); if (x < p.width - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - p.width); if (y < p.height - 1) stack.push(i + p.width);
  }
}

function bbox(p) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++)
    if (p.data[(y * p.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

// Recorta e reduz por média de área (alfa pré-multiplicado)
function cropScaled(p, [x0, y0, x1, y1], f) {
  const w = Math.max(1, Math.round((x1 - x0 + 1) * f)), h = Math.max(1, Math.round((y1 - y0 + 1) * f));
  const out = new PNG({ width: w, height: h });
  for (let oy = 0; oy < h; oy++) for (let ox = 0; ox < w; ox++) {
    const sx0 = x0 + ox / f, sx1 = x0 + (ox + 1) / f, sy0 = y0 + oy / f, sy1 = y0 + (oy + 1) / f;
    let r = 0, g = 0, b = 0, al = 0, n = 0;
    for (let y = Math.floor(sy0); y < Math.min(Math.ceil(sy1), p.height); y++) for (let x = Math.floor(sx0); x < Math.min(Math.ceil(sx1), p.width); x++) {
      const i = (y * p.width + x) * 4, a = p.data[i + 3];
      r += p.data[i] * a; g += p.data[i + 1] * a; b += p.data[i + 2] * a; al += a; n++;
    }
    const o = (oy * w + ox) * 4;
    if (al > 0) { out.data[o] = r / al; out.data[o + 1] = g / al; out.data[o + 2] = b / al; }
    out.data[o + 3] = n ? al / n : 0;
  }
  return out;
}

// Fundo da arena
fs.copyFileSync(path.join(SRC, 'Arena.jpg'), path.join(OUT, 'fundo_arena.jpg'));

for (const [src, dst] of [['Fundo Floresta.jpg', 'fundo_floresta.jpg'], ['Fundo Floresta 2.jpg', 'fundo_floresta_2.jpg'], ['Fundo Floresta 3.jpg', 'fundo_floresta_3.jpg']])
  fs.copyFileSync(path.join(SRC, src), path.join(OUT, dst));

// Placas: aparecem pequenas no jogo (~58 px de altura); guardadas em 2x para ficar nítidas
for (const [src, dst] of [['Placa arena.png', 'placa_arena.png'], ['Placa floresta.png', 'placa_floresta.png']]) {
  const p = read(path.join(SRC, src));
  keyOutWhiteBorder(p);
  const box = bbox(p);
  const f = 116 / (box[3] - box[1] + 1);
  const out = cropScaled(p, box, f);
  write(out, dst);
  console.log(dst, out.width + 'x' + out.height);
}

// Balão de chat: pergaminho. As pontas (rolos) não esticam; só o meio.
{
  const p = read(path.join(SRC, 'Balao de texto.png'));
  keyOutWhiteBorder(p);
  const box = bbox(p);
  const f = 0.6;
  const out = cropScaled(p, box, f);
  write(out, 'balao.png');
  const bw = box[2] - box[0] + 1, bh = box[3] - box[1] + 1;
  // medidas na imagem original (295x200): rolos ~ 50 px de cada lado; texto cabe entre ~58..237 px e ~28..172 px
  const meta = {
    width: out.width, height: out.height,
    capL: Math.round(52 * f), capR: Math.round(52 * f),
    padX: Math.round(8 * f), padTop: Math.round(34 * f), padBottom: Math.round(34 * f),
    source: [bw, bh],
  };
  fs.writeFileSync(path.join(OUT, 'balao.json'), JSON.stringify(meta));
  console.log('balao.png', out.width + 'x' + out.height, meta);
}
