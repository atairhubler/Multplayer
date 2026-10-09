// Prepara a moldura da projeção ("ilusão arcana") para o jogo:
// recorta a imagem em Personagens/compartilhar e mede a abertura transparente do centro,
// onde o vídeo da transmissão aparece. Gera Server/wwwroot/assets/projecao.png e projecao.json.
// Uso:  npm i pngjs  &&  node tools/build-projection-asset.js
const fs = require('fs'), path = require('path');
const { PNG } = require('pngjs');

const SRC = path.join(__dirname, '..', 'Personagens', 'compartilhar', 'projecao png.png');
const OUT = path.join(__dirname, '..', 'Server', 'wwwroot', 'assets');

const src = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, height: H, data } = src;
const alpha = (x, y) => data[(y * W + x) * 4 + 3];

// Caixa do desenho (parte visível)
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha(x, y) > 20) {
  x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
}

// Abertura do centro: região transparente ligada ao centro do desenho
const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
if (alpha(cx, cy) > 40) throw new Error('O centro da imagem não é transparente.');
const seen = new Uint8Array(W * H);
const stack = [[cx, cy]];
let ix0 = cx, ix1 = cx, iy0 = cy, iy1 = cy, touchesEdge = false;
seen[cy * W + cx] = 1;
while (stack.length) {
  const [x, y] = stack.pop();
  ix0 = Math.min(ix0, x); ix1 = Math.max(ix1, x); iy0 = Math.min(iy0, y); iy1 = Math.max(iy1, y);
  if (x <= x0 || x >= x1 || y <= y0 || y >= y1) touchesEdge = true;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx] || alpha(nx, ny) > 40) continue;
    seen[ny * W + nx] = 1;
    stack.push([nx, ny]);
  }
}
if (touchesEdge) throw new Error('A abertura do centro vaza para fora da moldura (o anel não é fechado).');

// Recorta o desenho (com uma pequena folga) e grava a posição da abertura em frações da imagem
const pad = 4;
const cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad);
const cw = Math.min(W - 1, x1 + pad) - cx0 + 1, ch = Math.min(H - 1, y1 + pad) - cy0 + 1;
const out = new PNG({ width: cw, height: ch });
PNG.bitblt(src, out, cx0, cy0, cw, ch, 0, 0);

const meta = {
  width: cw, height: ch,
  // elipse da abertura, em frações da largura/altura da imagem recortada
  cx: +(((ix0 + ix1) / 2 - cx0) / cw).toFixed(4),
  cy: +(((iy0 + iy1) / 2 - cy0) / ch).toFixed(4),
  rx: +(((ix1 - ix0 + 1) / 2 / cw).toFixed(4)),
  ry: +(((iy1 - iy0 + 1) / 2 / ch).toFixed(4)),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'projecao.png'), PNG.sync.write(out));
fs.writeFileSync(path.join(OUT, 'projecao.json'), JSON.stringify(meta, null, 1));
console.log('ok', meta);
