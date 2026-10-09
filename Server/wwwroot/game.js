// URL do backend no Render (troque após criar o serviço)
const PRODUCTION_URL = 'https://plataforma-multiplayer.onrender.com';
const SERVER_URL = location.hostname.endsWith('github.io') ? PRODUCTION_URL
  : location.protocol.startsWith('http') ? location.origin : 'http://localhost:5000';

const COLORS = { red: 0xe74c3c, blue: 0x3498db, green: 0x2ecc71, yellow: 0xf1c40f };
const WORLD_W = 1280, VIEW_H = 600; // mapa inteiro sempre visível (escala FIT)
const SEND_INTERVAL_MS = 50; // throttle: ~20 envios/s

let connection;
let myName = '';
let myCharacter = 'char:m:4a2c17:f1c27d:3498db';
let customImage = null; // data URL do avatar enviado pelo usuário

// ---- Upload de avatar: recorta em 2:3, reduz para 64x96 e comprime ----
const fileInput = document.getElementById('avatarFile');
const preview = document.getElementById('avatarPreview');
const MAX_IMAGE_CHARS = 40000; // imagens estáticas (recomprimidas)
const MAX_GIF_BYTES = 3 * 1024 * 1024; // GIFs animados são enviados por upload ao servidor (mesmo limite dele)

// Conta os quadros de um GIF percorrendo seus blocos
function countGifFrames(bytes) {
  let i = 6, frames = 0;
  const skipSub = () => { while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1; i++; };
  const flags = bytes[10];
  i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b === 0x21) { i++; skipSub(); }
    else if (b === 0x2c) {
      frames++;
      const f = bytes[i + 8];
      i += 9 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1;
      skipSub();
    } else break; // 0x3B (fim) ou dado inesperado
  }
  return frames;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    fr.readAsDataURL(file);
  });
}

async function processImage(file) {
  if (file.type === 'image/gif') {
    const frames = countGifFrames(new Uint8Array(await file.arrayBuffer()));
    if (frames > 1) { // animado: mantém o arquivo original (recomprimir no canvas perderia a animação)
      if (file.size > MAX_GIF_BYTES) throw new Error('GIF muito grande (máximo 3 MB).');
      return readAsDataURL(file);
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const W = 64, H = 96;
      let sw = img.width, sh = img.height;
      if (sw / sh > W / H) sw = sh * W / H; else sh = sw * H / W; // recorte central
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      canvas.getContext('2d').drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, W, H);
      for (const [type, q] of [['image/png'], ['image/webp', 0.8], ['image/jpeg', 0.7], ['image/jpeg', 0.4]]) {
        const data = canvas.toDataURL(type, q);
        if (data.startsWith('data:' + type) && data.length <= MAX_IMAGE_CHARS) return resolve(data);
      }
      reject(new Error('Imagem muito complexa.'));
    };
    img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
    img.src = url;
  });
}

fileInput.addEventListener('change', async () => {
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  customImage = null;
  preview.hidden = true;
  dollPreview.hidden = false;
  if (!fileInput.files[0]) return;
  try {
    customImage = await processImage(fileInput.files[0]);
    preview.src = customImage;
    preview.hidden = false;
    dollPreview.hidden = true;
  } catch (e) {
    errorEl.textContent = e.message;
    fileInput.value = '';
    dollPreview.hidden = false;
  }
});
// Mexer no boneco (gênero/cores) descarta a imagem enviada
const dollPreview = document.getElementById('dollPreview');
const dollInputs = document.querySelectorAll('input[name=gender], #cHair, #cSkin, #cCloth');
function currentDollConfig() {
  const hex = id => document.getElementById(id).value.slice(1).toLowerCase();
  const gender = document.querySelector('input[name=gender]:checked').value;
  return `char:${gender}:${hex('cHair')}:${hex('cSkin')}:${hex('cCloth')}`;
}
dollInputs.forEach(el => el.addEventListener('input', () => {
  customImage = null; preview.hidden = true; fileInput.value = ''; dollPreview.hidden = false;
  drawDollPreview(dollPreview, currentDollConfig());
}));

document.getElementById('join').addEventListener('click', async () => {
  myName = document.getElementById('name').value.trim() || 'Jogador';
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  const joinBtn = document.getElementById('join');
  try { await dollAssetsReady; } catch {
    errorEl.textContent = 'Não foi possível carregar as imagens do personagem.';
    return;
  }

  if (customImage && customImage.startsWith('data:image/gif')) {
    // GIF animado: sobe o arquivo e usa só a URL devolvida pelo servidor
    joinBtn.disabled = true;
    errorEl.textContent = 'Enviando GIF...';
    try {
      const res = await fetch(`${SERVER_URL}/avatars`, { method: 'POST', body: fileInput.files[0] });
      if (!res.ok) throw new Error();
      myCharacter = (await res.json()).url;
      errorEl.textContent = '';
    } catch {
      errorEl.textContent = 'Não foi possível enviar o GIF. Se o servidor estava dormindo, tente de novo em ~1 min.';
      joinBtn.disabled = false;
      return;
    }
    joinBtn.disabled = false;
  } else {
    myCharacter = customImage || currentDollConfig();
  }

  connection = new signalR.HubConnectionBuilder()
    .withUrl(`${SERVER_URL}/gamehub`)
    .withAutomaticReconnect()
    .build();

  try {
    await connection.start();
  } catch (e) {
    errorEl.textContent = 'Não foi possível conectar. Se o servidor estava dormindo, tente de novo em ~1 min.';
    return;
  }

  document.getElementById('login').style.display = 'none';
  setupChat();
  startPhaser();
});

function startPhaser() {
  phaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: WORLD_W,
    height: VIEW_H,
    backgroundColor: '#87ceeb',
    physics: { default: 'arcade', arcade: { gravity: { y: 800 }, debug: false } },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: { preload, create, update }
  });
}

const remotePlayers = {}; // id -> { rect, label, targetX, targetY }
let player, localSprite, nameLabel, cursors, lastSent = 0, lastX = 0, lastY = 0;

const gifSprites = new Set(); // { sprite, img }
let phaserGame;

function updateGifs() {
  const r = phaserGame.canvas.getBoundingClientRect();
  const k = r.width / WORLD_W;
  for (const { sprite, img } of gifSprites) {
    img.style.width = 32 * k + 'px';
    img.style.height = 48 * k + 'px';
    img.style.transform = `translate(${r.left + (sprite.x - 16) * k}px, ${r.top + (sprite.y - 24) * k}px)`;
  }
}

// Cria o sprite de um personagem: cor sólida, ou imagem enviada (carregada de forma assíncrona)
function makeSprite(scene, character) {
  if (character.startsWith('char:')) return createDoll(scene, character);
  const isImage = character.startsWith('data:image/');
  const isUpload = character.startsWith('/avatars/');
  const sprite = scene.add.image(0, 0, isImage || isUpload ? 'c_gray' : 'c_' + character).setDisplaySize(32, 48);
  if (isUpload) {
    // GIF animado: o canvas não anima, então uma <img> HTML acompanha o sprite (que fica invisível)
    const img = document.createElement('img');
    img.className = 'gifSprite';
    img.src = SERVER_URL + character;
    document.getElementById('sprites').appendChild(img);
    sprite.setAlpha(0);
    gifSprites.add({ sprite, img });
    sprite.once('destroy', () => { img.remove(); for (const g of gifSprites) if (g.sprite === sprite) gifSprites.delete(g); });
    return sprite;
  }
  if (isImage) {
    const key = 'u_' + character.length + '_' + character.slice(-40);
    const apply = () => { if (sprite.active) sprite.setTexture(key).setDisplaySize(32, 48); };
    if (scene.textures.exists(key)) apply();
    else {
      const img = new Image();
      img.onload = () => { if (!scene.textures.exists(key)) scene.textures.addImage(key, img); apply(); };
      img.src = character;
    }
  }
  return sprite;
}

function createColorTextures(scene) {
  const g = scene.add.graphics();
  for (const [name, color] of Object.entries({ ...COLORS, gray: 0x999999 })) {
    g.clear().fillStyle(color).fillRect(0, 0, 32, 48);
    g.generateTexture('c_' + name, 32, 48);
  }
  g.destroy();
}

function createRemote(scene, p, announce = false) {
  if (remotePlayers[p.id]) return;
  const rect = makeSprite(scene, p.characterSprite || 'red').setPosition(p.x, p.y);
  if (announce) addChatLine(null, p.name + ' entrou');
  const label = scene.add.text(p.x, p.y - 38, p.name, {
    fontSize: '14px', color: '#fff', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5);
  remotePlayers[p.id] = { rect, label, name: p.name, targetX: p.x, targetY: p.y };
}

// ---- Balões de fala sobre a cabeça ----
let gameScene;
const bubbles = {}; // id -> { text, expires }

function showBubble(id, message) {
  if (!gameScene) return;
  bubbles[id]?.text.destroy();
  const text = gameScene.add.text(0, 0, message, {
    fontSize: '14px', color: '#111', backgroundColor: '#ffffff', align: 'center',
    padding: { x: 8, y: 5 }, wordWrap: { width: 170, useAdvancedWrap: true }
  }).setOrigin(0.5, 1).setDepth(10);
  bubbles[id] = { text, expires: gameScene.time.now + 3000 + message.length * 60 };
}

function updateBubbles(now) {
  for (const id in bubbles) {
    const b = bubbles[id];
    const anchor = id === connection.connectionId ? player : remotePlayers[id]?.rect;
    if (!anchor || now > b.expires) { b.text.destroy(); delete bubbles[id]; continue; }
    const half = b.text.width / 2;
    b.text.setPosition(Phaser.Math.Clamp(anchor.x, half, WORLD_W - half), anchor.y - 50);
  }
}

// ---- Fundo que muda conforme a hora do dia (relógio do aparelho de cada jogador) ----
// 10h–14h59 usa a imagem das 10h, 15h–17h59 a das 15h, e das 18h às 9h59 a das 18h.
const BACKGROUNDS = { 10: 'assets/fundo_10h.jpg', 15: 'assets/fundo_15h.jpg', 18: 'assets/fundo_18h.jpg' };
const backgroundForHour = h => (h >= 18 || h < 10 ? 18 : h >= 15 ? 15 : 10);
let background, backgroundPeriod, lastBackgroundCheck = 0;

function preload() {
  backgroundPeriod = backgroundForHour(new Date().getHours());
  this.load.image('bg' + backgroundPeriod, BACKGROUNDS[backgroundPeriod]);
}

function updateBackground(scene, time) {
  if (time - lastBackgroundCheck < 5000) return; // confere a cada 5 s
  lastBackgroundCheck = time;
  const period = backgroundForHour(new Date().getHours());
  if (period === backgroundPeriod) return;
  backgroundPeriod = period;
  const key = 'bg' + period;
  const apply = () => { if (backgroundPeriod === period) background.setTexture(key).setDisplaySize(WORLD_W, VIEW_H); };
  if (scene.textures.exists(key)) apply();
  else { // carrega a imagem só quando for preciso
    scene.load.image(key, BACKGROUNDS[period]);
    scene.load.once('complete', apply);
    scene.load.start();
  }
}

function create() {
  const scene = this;
  gameScene = this;

  createColorTextures(this);
  background = this.add.image(0, 0, 'bg' + backgroundPeriod).setOrigin(0).setDisplaySize(WORLD_W, VIEW_H).setDepth(-10);

  // Mapa: só o chão (invisível; a rua desenhada no fundo é o chão visível)
  const platforms = this.physics.add.staticGroup();
  const addPlatform = (x, y, w, h, color) => {
    const r = this.add.rectangle(x, y, w, h, color ?? 0).setVisible(color !== null);
    this.physics.add.existing(r, true);
    platforms.add(r);
  };
  addPlatform(WORLD_W / 2, 580, WORLD_W, 40, null); // chão invisível (o chão visível é a rua do fundo)

  // Jogador local
  // O corpo físico é um retângulo invisível; a imagem do personagem o acompanha
  player = this.add.rectangle(0, 0, 32, 48).setVisible(false);
  localSprite = makeSprite(this, myCharacter);
  this.physics.add.existing(player);
  player.x = 100; player.y = 400;
  player.body.setCollideWorldBounds(true);
  this.physics.add.collider(player, platforms);
  nameLabel = this.add.text(0, 0, myName, {
    fontSize: '14px', color: '#fff', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5);

  this.physics.world.setBounds(0, 0, WORLD_W, VIEW_H);

  cursors = this.input.keyboard.createCursorKeys();
  // Não bloqueia as setas/espaço no resto da página (o campo do chat precisa delas)
  this.input.keyboard.removeCapture('UP,DOWN,LEFT,RIGHT,SPACE');

  // Handlers do SignalR (nomes em camelCase vindos do JSON)
  connection.on('ExistingPlayers', list => list.forEach(p => createRemote(scene, p)));
  connection.on('PlayerJoined', p => createRemote(scene, p, true));
  connection.on('PlayerMoved', (id, x, y) => {
    const r = remotePlayers[id];
    if (r) { r.targetX = x; r.targetY = y; }
  });
  connection.on('PlayerLeft', id => {
    const r = remotePlayers[id];
    if (!r) return;
    addChatLine(null, r.name + ' saiu');
    r.rect.destroy();
    r.label.destroy();
    delete remotePlayers[id];
  });

  connection.invoke('JoinGame', myName, myCharacter);
}

function update(time, delta) {
  const body = player.body;
  const typing = document.activeElement === chatInput;
  const left = (!typing && cursors.left.isDown) || touch.left;
  const right = (!typing && cursors.right.isDown) || touch.right;
  const jump = (!typing && cursors.up.isDown) || touch.jump;
  if (left) body.setVelocityX(-200);
  else if (right) body.setVelocityX(200);
  else body.setVelocityX(0);

  if (jump && body.blocked.down) body.setVelocityY(-500);

  localSprite.setPosition(player.x, player.y);
  if (localSprite.animate) {
    const vx = body.velocity.x;
    localSprite.animate(Math.abs(vx) > 10, !body.blocked.down, vx, delta);
  }
  nameLabel.setPosition(player.x, player.y - 38);

  // Envia posição só se mudou, com throttle
  if (time - lastSent > SEND_INTERVAL_MS &&
      (Math.abs(player.x - lastX) > 0.5 || Math.abs(player.y - lastY) > 0.5)) {
    connection.invoke('UpdatePosition', player.x, player.y);
    lastSent = time; lastX = player.x; lastY = player.y;
  }

  updateBubbles(time);

  // Interpolação suave dos remotos
  for (const id in remotePlayers) {
    const r = remotePlayers[id];
    const dx = r.targetX - r.rect.x, dy = r.targetY - r.rect.y;
    r.rect.x = Phaser.Math.Linear(r.rect.x, r.targetX, 0.25);
    r.rect.y = Phaser.Math.Linear(r.rect.y, r.targetY, 0.25);
    r.rect.animate?.(Math.abs(dx) > 0.8, Math.abs(dy) > 2, dx, delta);
    r.label.setPosition(r.rect.x, r.rect.y - 38);
  }
  updateGifs();
  positionChat();
  updateBackground(this, time);
}

// ---- Controles de toque (celular) ----
const touch = { left: false, right: false, jump: false };
document.querySelectorAll('#touch button[data-key]').forEach(btn => {
  const key = btn.dataset.key;
  const set = v => e => { e.preventDefault(); touch[key] = v; };
  btn.addEventListener('pointerdown', set(true));
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, set(false)));
  btn.addEventListener('contextmenu', e => e.preventDefault());
});
if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
  document.getElementById('touch').style.display = 'flex';
}

// ---- Chat ----
const chatEl = document.getElementById('chat');
const chatLog = document.getElementById('chatLog');
const OLD_AFTER_MS = 12000; // linhas antigas ficam mais apagadas, como em chats de MMORPG

// Usa textContent (nunca innerHTML) para que mensagens não injetem HTML
function addChatLine(name, text) {
  const p = document.createElement('p');
  if (name === null) {
    p.className = 'sys';
    p.textContent = text;
  } else {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name + ': ';
    p.append(who, document.createTextNode(text));
  }
  // só acompanha as novas mensagens se o usuário não estiver lendo o histórico mais acima
  const stick = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 30;
  chatLog.appendChild(p);
  while (chatLog.children.length > 300) chatLog.firstChild.remove();
  if (stick) chatLog.scrollTop = chatLog.scrollHeight;
  setTimeout(() => p.classList.add('old'), OLD_AFTER_MS);
}

// Mantém o chat DENTRO da área do jogo (canvas), mesmo quando há faixas pretas ao redor
const coarsePointer = matchMedia('(pointer: coarse)').matches;
function positionChat() {
  const r = phaserGame.canvas.getBoundingClientRect();
  chatEl.style.left = r.left + 12 + 'px';
  chatEl.style.width = Math.min(coarsePointer ? 250 : 360, r.width * 0.45) + 'px';
  chatLog.style.maxHeight = r.height * (coarsePointer ? 0.4 : 0.5) + 'px'; // até a metade do jogo
  if (coarsePointer) { // no celular os botões de toque ocupam a parte de baixo: chat no topo
    chatEl.style.top = r.top + 8 + 'px';
    chatEl.style.bottom = 'auto';
  } else {
    chatEl.style.bottom = innerHeight - r.bottom + 12 + 'px';
    chatEl.style.top = 'auto';
  }
}

function setupChat() {
  chatEl.classList.add('on');
  connection.on('ChatHistory', list => list.forEach(m => addChatLine(m.name, m.text)));
  connection.on('ChatMessage', m => { addChatLine(m.name, m.text); showBubble(m.id, m.text); });
  chatReady = true;
}

// Enter abre a caixa de mensagem na parte inferior; Enter de novo envia e fecha; Esc cancela
const chatBar = document.getElementById('chatBar');
const chatInput = document.getElementById('chatInput');
let chatReady = false;

function openChatBar() {
  chatBar.hidden = false;
  chatEl.classList.add('active');
  chatLog.scrollTop = chatLog.scrollHeight;
  chatInput.focus();
}

function closeChatBar() {
  chatBar.hidden = true;
  chatEl.classList.remove('active');
  chatInput.value = '';
  chatInput.blur(); // devolve o controle ao teclado do jogo
}

window.addEventListener('keydown', e => {
  if (e.key === 'Enter' && chatReady && chatBar.hidden) {
    e.preventDefault();
    openChatBar();
  }
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeChatBar();
});
chatInput.addEventListener('blur', () => { if (!chatBar.hidden) closeChatBar(); });
chatBar.addEventListener('submit', e => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text) connection.invoke('SendMessage', text);
  closeChatBar();
});
document.getElementById('talkBtn').addEventListener('click', () => { if (chatReady) openChatBar(); });

// ---- Boneco montado com as imagens (peças recortadas, recoloridas por zona de cor) ----
// As imagens originais usam cores-chave: pele = laranja, cabelo = azul, roupa = verde.
// Cada pixel dessas zonas troca de matiz/cor pela escolha do usuário, mantendo o sombreado.
// Posições/pivôs das peças vêm de assets/dolls.json (gerado por tools/build-doll-assets.js).
const ASSET_DIR = 'assets/';
let dollLayout = null;
const dollImages = {};
const dollAssetsReady = (async () => {
  dollLayout = await (await fetch(ASSET_DIR + 'dolls.json')).json();
  await Promise.all(Object.values(dollLayout).flat().map(p => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { dollImages[p.file] = img; resolve(); };
    img.onerror = reject;
    img.src = ASSET_DIR + p.file;
  })));
})();

function parseDoll(config) {
  const [, g, hair, skin, cloth] = config.split(':');
  return { female: g === 'f', hair: '#' + hair, skin: '#' + skin, cloth: '#' + cloth };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}

function hslToRgb(h, sat, l) {
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hexToHsl = hex => { const n = parseInt(hex.slice(1), 16); return rgbToHsl(n >> 16, (n >> 8) & 255, n & 255); };

// Zonas de cor das imagens originais: faixa de matiz e luminosidade média (base do sombreado)
const ZONES = [
  { key: 'skin', from: 8, to: 55, base: 0.5 },
  { key: 'cloth', from: 95, to: 175, base: 0.31 },
  { key: 'hair', from: 190, to: 255, base: 0.44 },
];

const recolorCache = {};
function recoloredPart(file, cfg) {
  const id = [file, cfg.hair, cfg.skin, cfg.cloth].join('|');
  if (recolorCache[id]) return recolorCache[id];
  const img = dollImages[file];
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const target = { skin: hexToHsl(cfg.skin), cloth: hexToHsl(cfg.cloth), hair: hexToHsl(cfg.hair) };
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [h, sat, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (sat < 0.4 || l < 0.1) continue; // contorno, cinza (sapatos), branco dos olhos: não mexe
    const zone = ZONES.find(z => h >= z.from && h <= z.to);
    if (!zone) continue;
    const [th, ts, tl] = target[zone.key];
    const nl = Math.max(0.04, Math.min(0.96, tl + (l - zone.base)));
    const [r, g, b] = hslToRgb(th, ts, nl);
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
  ctx.putImageData(data, 0, 0);
  return (recolorCache[id] = canvas);
}

// Pré-visualização estática no login
async function drawDollPreview(canvas, config) {
  await dollAssetsReady;
  const cfg = parseDoll(config);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const S = canvas.height / 62, cx = canvas.width / 2 + 4 * S, cy = canvas.height / 2;
  for (const p of dollLayout[cfg.female ? 'f' : 'm']) {
    const c = recoloredPart(p.file, cfg);
    const dw = c.width * p.scale * S, dh = c.height * p.scale * S;
    ctx.save();
    if (p.id.endsWith('Far')) ctx.filter = 'brightness(0.8)';
    ctx.drawImage(c, cx + p.x * S - p.ox * dw, cy + p.y * S - p.oy * dh, dw, dh);
    ctx.restore();
  }
}

// Boneco animado no Phaser: contêiner (vira para o lado) > peças com pivô nas articulações
function createDoll(scene, config) {
  const cfg = parseDoll(config);
  const rig = scene.add.container(0, 0);
  const part = {};
  for (const p of dollLayout[cfg.female ? 'f' : 'm']) {
    const key = ['doll', p.file, cfg.hair, cfg.skin, cfg.cloth].join('|');
    if (!scene.textures.exists(key)) scene.textures.addCanvas(key, recoloredPart(p.file, cfg));
    const img = scene.add.image(p.x, p.y, key).setOrigin(p.ox, p.oy).setScale(p.scale);
    if (p.id.endsWith('Far')) img.setTint(0xc8c8c8); // membros do lado de trás ficam mais escuros
    rig.add(img);
    part[p.id] = img;
  }
  const doll = scene.add.container(0, 0, [rig]);
  let phase = 0, dir = 1;

  doll.animate = (moving, air, vx, dt = 16) => {
    if (Math.abs(vx) > 0.5) dir = vx > 0 ? 1 : -1;
    doll.scaleX = dir;
    let aN = 0, aF = 0, lN = 0, lF = 0, bob = 0;
    if (air) { lN = -0.7; lF = 0.5; aN = -2.3; aF = -1.9; }
    else if (moving) {
      phase += dt * 0.014;
      const sw = Math.sin(phase);
      lN = sw * 0.8; lF = -sw * 0.8; aN = -sw * 0.9; aF = sw * 0.9;
      bob = -Math.abs(Math.cos(phase)) * 1.2;
    } else {
      bob = Math.sin(scene.time.now * 0.004) * 0.4;
    }
    const k = 1 - Math.exp(-dt * 0.02); // suaviza a transição entre poses
    const ease = (obj, target) => { obj.rotation += (target - obj.rotation) * k; };
    ease(part.armNear, aN); ease(part.armFar, aF);
    ease(part.legNear, lN); ease(part.legFar, lF);
    rig.y += (bob - rig.y) * k;
  };
  return doll;
}

drawDollPreview(document.getElementById('dollPreview'), currentDollConfig());
