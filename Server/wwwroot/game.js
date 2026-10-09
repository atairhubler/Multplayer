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
    scene: { create, update }
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

function create() {
  const scene = this;
  gameScene = this;

  createColorTextures(this);

  // Mapa: chão + 3 plataformas (retângulos estáticos)
  const platforms = this.physics.add.staticGroup();
  const addPlatform = (x, y, w, h, color) => {
    const r = this.add.rectangle(x, y, w, h, color);
    this.physics.add.existing(r, true);
    platforms.add(r);
  };
  addPlatform(WORLD_W / 2, 580, WORLD_W, 40, 0x228b22); // chão
  addPlatform(200, 450, 200, 20, 0x8b5a2b);
  addPlatform(520, 340, 200, 20, 0x8b5a2b);
  addPlatform(150, 220, 160, 20, 0x8b5a2b);
  addPlatform(850, 450, 200, 20, 0x8b5a2b);
  addPlatform(1100, 320, 200, 20, 0x8b5a2b);

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

// ---- Boneco desenhado por código (masculino/feminino, cores personalizáveis) ----
// Cada parte é uma lista de formas desenhadas em torno de um pivô; o mesmo desenho
// serve para o jogo (Phaser) e para a pré-visualização do login (canvas 2D).
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return '#' + [16, 8, 0].map(s => c(s).toString(16).padStart(2, '0')).join('');
}

function parseDoll(config) {
  const [, g, hair, skin, cloth] = config.split(':');
  return { female: g === 'f', hair: '#' + hair, skin: '#' + skin, cloth: '#' + cloth };
}

// Posições relativas ao centro do personagem (32x48). Ordem = do fundo para a frente.
function dollParts(cfg) {
  const { female, hair, skin, cloth } = cfg;
  const skinD = shade(skin, 0.82), clothD = shade(cloth, 0.8), hairD = shade(hair, 0.85), shoe = '#2b2b2b';
  const arm = (sk, cl) => [
    ['rect', -2, 0, 4, 11, sk], ['rect', -2, 0, 4, 5, cl], ['ellipse', 0, 11, 4.5, 4.5, sk]];
  const leg = (sk, cl) => [
    ['rect', -2.5, 0, 5, 14, female ? sk : cl], ['rect', -2.5, 14, 7, 4, shoe]];
  const parts = [
    { id: 'armFar', px: 0, py: -3, ops: arm(skinD, clothD) },
    { id: 'legFar', px: 0, py: 6, ops: leg(skinD, clothD) },
  ];
  if (female) parts.push({ id: 'tail', px: -7, py: -17, ops: [['ellipse', -3, 5, 6, 13, hair]] });
  parts.push(
    { id: 'torso', px: 0, py: 0, ops: [
      ['rect', -2, -7, 4, 3, skin],                          // pescoço
      ['rect', -6, -5, 12, 12, cloth],
      ...(female ? [['poly', [[-6, 3], [6, 3], [9, 12], [-9, 12]], cloth]] : [['rect', -6, 5, 12, 2, clothD]]),
    ] },
    { id: 'legNear', px: 0, py: 6, ops: leg(skin, cloth) },
    { id: 'head', px: 0, py: -14, ops: [
      ['circle', 0, 0, 9, skin], ['ellipse', 4, -1, 2, 3.2, '#222'], ['circle', -1, 1, 1.8, skinD]] },
    { id: 'hair', px: 0, py: -14, ops: [
      ['halfTop', 0, -1, 10.5, hair],
      ['rect', -10.5, -1, 6, female ? 12 : 7, hair],
      ['poly', [[3, -10], [10, -4], [10, -1], [4, -5]], hair]] },
    { id: 'armNear', px: 0, py: -3, ops: arm(skin, cloth) },
  );
  return parts;
}

function drawOpsPhaser(g, ops) {
  const col = c => parseInt(c.slice(1), 16);
  for (const [t, ...a] of ops) {
    if (t === 'rect') g.fillStyle(col(a[4])).fillRect(a[0], a[1], a[2], a[3]);
    else if (t === 'ellipse') g.fillStyle(col(a[4])).fillEllipse(a[0], a[1], a[2], a[3]);
    else if (t === 'circle') g.fillStyle(col(a[3])).fillCircle(a[0], a[1], a[2]);
    else if (t === 'poly') g.fillStyle(col(a[1])).fillPoints(a[0].map(([x, y]) => ({ x, y })), true);
    else if (t === 'halfTop') { g.fillStyle(col(a[3])).beginPath().slice(a[0], a[1], a[2], Math.PI, 2 * Math.PI, false).closePath().fillPath(); }
  }
}

function drawOpsCanvas(ctx, ops) {
  for (const [t, ...a] of ops) {
    if (t === 'rect') { ctx.fillStyle = a[4]; ctx.fillRect(a[0], a[1], a[2], a[3]); }
    else if (t === 'ellipse') { ctx.fillStyle = a[4]; ctx.beginPath(); ctx.ellipse(a[0], a[1], a[2] / 2, a[3] / 2, 0, 0, 2 * Math.PI); ctx.fill(); }
    else if (t === 'circle') { ctx.fillStyle = a[3]; ctx.beginPath(); ctx.arc(a[0], a[1], a[2], 0, 2 * Math.PI); ctx.fill(); }
    else if (t === 'poly') { ctx.fillStyle = a[1]; ctx.beginPath(); a[0].forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill(); }
    else if (t === 'halfTop') { ctx.fillStyle = a[3]; ctx.beginPath(); ctx.arc(a[0], a[1], a[2], Math.PI, 2 * Math.PI); ctx.closePath(); ctx.fill(); }
  }
}

// Pré-visualização estática no login
function drawDollPreview(canvas, config) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(canvas.width / 32 * 0.9, canvas.height / 48 * 0.9);
  ctx.translate(16 / 0.9, 24.5 / 0.9);
  for (const p of dollParts(parseDoll(config))) {
    ctx.save(); ctx.translate(p.px, p.py); drawOpsCanvas(ctx, p.ops); ctx.restore();
  }
  ctx.restore();
}

// Boneco animado no Phaser: contêiner (vira para o lado) > partes com pivôs nas articulações
function createDoll(scene, config) {
  const cfg = parseDoll(config);
  const rig = scene.add.container(0, 0);
  const part = {};
  for (const p of dollParts(cfg)) {
    const g = scene.add.graphics({ x: p.px, y: p.py });
    drawOpsPhaser(g, p.ops);
    rig.add(g);
    part[p.id] = g;
  }
  const doll = scene.add.container(0, 0, [rig]);
  let phase = 0, dir = 1;

  doll.animate = (moving, air, vx, dt = 16) => {
    if (Math.abs(vx) > 0.5) dir = vx > 0 ? 1 : -1;
    doll.scaleX = dir;
    let aN = 0, aF = 0, lN = 0, lF = 0, bob = 0, tail = 0;
    if (air) { lN = -0.7; lF = 0.5; aN = -2.3; aF = -1.9; tail = 0.5; }
    else if (moving) {
      phase += dt * 0.014;
      const s = Math.sin(phase);
      lN = s * 0.8; lF = -s * 0.8; aN = -s * 0.9; aF = s * 0.9;
      bob = -Math.abs(Math.cos(phase)) * 1.8; tail = 0.2 + Math.sin(phase + 1) * 0.3;
    } else {
      bob = Math.sin(scene.time.now * 0.004) * 0.5;
    }
    const k = 1 - Math.exp(-dt * 0.02); // suaviza a transição entre poses
    const ease = (obj, target) => { obj.rotation += (target - obj.rotation) * k; };
    ease(part.armNear, aN); ease(part.armFar, aF);
    ease(part.legNear, lN); ease(part.legFar, lF);
    if (part.tail) ease(part.tail, tail);
    rig.y += (bob - rig.y) * k;
  };
  return doll;
}

drawDollPreview(document.getElementById('dollPreview'), currentDollConfig());
