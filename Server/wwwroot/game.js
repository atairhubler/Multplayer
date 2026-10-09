// Páginas em cache: logo depois de uma atualização o navegador pode misturar um index.html antigo com este game.js novo
// (faltam elementos, o script quebra no meio e o personagem "trava" até apertar F5). Se faltar algum elemento, recarrega uma vez.
(() => {
  const need = ['join', 'stick', 'stickKnob', 'fsBtn', 'fsBtnDesk', 'chat', 'online', 'sfxBtn', 'helpBtn', 'helpModal', 'moveHint', 'arenaRank', 'arenaBar', 'arenaMsg', 'arenaWeapons', 'attackBtn'];
  let missing = need.some(id => !document.getElementById(id));
  try {
    if (!missing) { sessionStorage.removeItem('staleReload'); return; }
    if (sessionStorage.getItem('staleReload') === '1') return; // já tentou: não entra em laço
    sessionStorage.setItem('staleReload', '1');
  } catch { if (!missing) return; }
  fetch(location.href, { cache: 'reload' }).catch(() => {}).finally(() => location.reload());
})();

// URL do backend no Render (troque após criar o serviço)
const PRODUCTION_URL = 'https://plataforma-multiplayer.onrender.com';
const SERVER_URL = location.hostname.endsWith('github.io') ? PRODUCTION_URL
  : location.protocol.startsWith('http') ? location.origin : 'http://localhost:5000';

const COLORS = { red: 0xe74c3c, blue: 0x3498db, green: 0x2ecc71, yellow: 0xf1c40f };
const WORLD_W = 1280, VIEW_H = 600; // mapa inteiro sempre visível (escala FIT)
const GROUND_TOP = 594; // onde os pés ficam: bem perto do limite de baixo, na calçada do fundo
const SEND_INTERVAL_MS = 50; // throttle: ~20 envios/s
const CHAR_SCALE = 1.4; // tamanho do personagem (1 = 32x48)
const CHAR_W = Math.round(32 * CHAR_SCALE), CHAR_H = Math.round(48 * CHAR_SCALE);
const LABEL_DY = CHAR_H / 2 + 14, BUBBLE_DY = CHAR_H / 2 + 26; // nome e balão acima da cabeça

let connection;
let currentMap = 'village'; // 'village' (vilarejo), 'forest' (floresta) ou 'arena'
const isCombat = () => currentMap === 'arena' || currentMap === 'forest'; // mapas com vida, armas e ranking
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
  unlockAudio(); // precisa acontecer dentro do clique (política dos navegadores)
  if (matchMedia('(pointer: coarse)').matches) { // celular: tela cheia + paisagem (onde o navegador permitir)
    document.documentElement.requestFullscreen?.()
      .then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  }
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
  saveProfile();
  setupChat();
  startMusic();
  startPhaser();
});

// Ajusta o jogo à área visível agora: ao sair da tela cheia, girar o celular ou aparecer/sumir a barra do navegador,
// o tamanho muda aos poucos; por isso reajusta algumas vezes seguidas.
function fitGameToWindow() {
  const el = document.getElementById('game');
  const vv = window.visualViewport;
  el.style.width = Math.round(vv ? vv.width : innerWidth) + 'px';
  el.style.height = Math.round(vv ? vv.height : innerHeight) + 'px';
  const t = document.getElementById('touch'); // os botões de toque ficam dentro da área visível (a barra do navegador pode cobrir o "bottom" da janela)
  t.style.left = Math.round(vv ? vv.offsetLeft : 0) + 'px';
  t.style.top = Math.round(vv ? vv.offsetTop : 0) + 'px';
  t.style.width = el.style.width; t.style.height = el.style.height;
  try { phaserGame?.scale?.refresh(); } catch {}
}
function fitGameSoon() {
  fitGameToWindow();
  [100, 300, 700].forEach(ms => setTimeout(fitGameToWindow, ms));
}
['resize', 'orientationchange', 'fullscreenchange', 'webkitfullscreenchange'].forEach(ev => window.addEventListener(ev, fitGameSoon));
document.addEventListener('fullscreenchange', fitGameSoon);
document.addEventListener('webkitfullscreenchange', fitGameSoon);
window.visualViewport?.addEventListener('resize', fitGameSoon);

function startPhaser() {
  fitGameToWindow();
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
    img.style.display = sprite.visible ? '' : 'none';
    img.style.width = CHAR_W * k + 'px';
    img.style.height = CHAR_H * k + 'px';
    img.style.transform = `translate(${r.left + (sprite.x - CHAR_W / 2) * k}px, ${r.top + (sprite.y - CHAR_H / 2) * k}px)`;
  }
}

// Cria o sprite de um personagem: cor sólida, ou imagem enviada (carregada de forma assíncrona)
function makeSprite(scene, character) {
  if (character.startsWith('char:')) return createDoll(scene, character);
  const isImage = character.startsWith('data:image/');
  const isUpload = character.startsWith('/avatars/');
  const sprite = scene.add.image(0, 0, isImage || isUpload ? 'c_gray' : 'c_' + character).setDisplaySize(CHAR_W, CHAR_H);
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
    const apply = () => { if (sprite.active) sprite.setTexture(key).setDisplaySize(CHAR_W, CHAR_H); };
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

const LABEL_STYLE = { fontSize: '14px', color: '#ffffff', stroke: '#000', strokeThickness: 3, align: 'center' };
const myId = () => connection?.connectionId;
const localInfo = { label: null, name: '', title: null, nameColor: '#ffffff' };
const ridingMap = {}; // id de quem está montado -> id de quem carrega
const RIDE_STEP = CHAR_H * 0.72; // quanto cada nível da torre sobe
const TOWER_MAX = 10; // o servidor também limita a altura da torre
// quantos níveis há de quem carrega `id` até a base (0 = está no chão)
function chainDepth(id) {
  let n = 0;
  for (let c = ridingMap[id]; c && n <= TOWER_MAX; c = ridingMap[c]) n++;
  return n;
}
// quantos jogadores há empilhados em cima de `id` (torre de jogadores)
function levelsAbove(id) {
  let n = 0;
  for (let cur = id; n <= TOWER_MAX; n++) {
    const up = Object.keys(ridingMap).find(r => ridingMap[r] === cur);
    if (!up) break;
    cur = up;
  }
  return n;
}
// quem está carregando alguém tem o nome e o balão mais acima, para não ficarem por cima de quem está nas costas
const liftFor = id => { const n = levelsAbove(id); return n ? n * (RIDE_STEP + 18) + 16 : 0; };

const isIt = id => tagState.active && tagState.itId === id;

// Nome (com o título numa linha acima), na cor escolhida; o pegador do pique-pega aparece em vermelho
function refreshLabel(id) {
  const info = id === myId() ? localInfo : remotePlayers[id];
  if (!info || !info.label) return;
  const it = isIt(id);
  info.label.setText((it ? '🔴 ' : '') + (info.speaking ? '🎙️ ' : '') + (info.title ? info.title + '\n' : '') + info.name);
  info.label.setColor(it ? '#ff6b6b' : info.nameColor || '#ffffff');
}
const refreshAllLabels = () => { refreshLabel(myId()); Object.keys(remotePlayers).forEach(refreshLabel); };
const LABEL_MIN_Y = LABEL_DY + 4; // em torres altas o nome não sai pela borda de cima da tela
const placeLabel = (label, x, y) => label.setPosition(x, y - LABEL_DY + 9);

function createRemote(scene, p, announce = false) {
  if (remotePlayers[p.id]) return;
  const rect = makeSprite(scene, p.characterSprite || 'red').setPosition(p.x, p.y);
  if (announce) { addChatLine(null, p.name + ' entrou', true); playChime(); }
  const label = scene.add.text(p.x, p.y, p.name, LABEL_STYLE).setOrigin(0.5, 1);
  remotePlayers[p.id] = {
    rect, label, name: p.name, title: p.title || null, nameColor: p.nameColor || null,
    dancing: !!p.dancing, targetX: p.x, targetY: p.y, map: p.map || 'village',
  };
  syncVisibility(p.id);
  if (p.ridingOn) { ridingMap[p.id] = p.ridingOn; rect.setDepth(2); }
  refreshLabel(p.id);
  renderOnline();
  if (p.sharing) markSharer(p.id); // já estava compartilhando a tela quando você entrou (a projeção aparece; assistir é por interação)
}

// ---- Balões de fala sobre a cabeça ----
let gameScene;
const bubbles = {}; // id -> { text, expires }

function showBubble(id, message) {
  if (!gameScene) return;
  bubbles[id]?.text.destroy();
  const m = gameScene.cache.json.get('balaoMeta');
  if (!m) { // sem a arte do pergaminho: balão simples
    const t = gameScene.add.text(0, 0, message, { fontSize: '14px', color: '#111', backgroundColor: '#ffffff', align: 'center',
      padding: { x: 8, y: 5 }, wordWrap: { width: 170, useAdvancedWrap: true } }).setOrigin(0.5, 1).setDepth(10);
    bubbles[id] = { text: t, expires: gameScene.time.now + 3000 + message.length * 60 };
    return;
  }
  // pergaminho em 3 partes: as pontas (rolos) mantêm o formato e só o meio estica conforme o texto
  const tex = gameScene.textures.get('balao');
  if (!tex.has('balao_l')) {
    tex.add('balao_l', 0, 0, 0, m.capL, m.height);
    tex.add('balao_m', 0, m.capL, 0, m.width - m.capL - m.capR, m.height);
    tex.add('balao_r', 0, m.width - m.capR, 0, m.capR, m.height);
  }
  const text = gameScene.add.text(0, 0, message, {
    fontSize: '13px', fontStyle: 'bold', color: '#3b2410', align: 'center', lineSpacing: 2,
    wordWrap: { width: 170, useAdvancedWrap: true },
  }).setOrigin(0.5);
  const textW = Math.max(text.width, 28), textH = text.height;
  const s = Math.max(0.55, (textH + 8) / (m.height - m.padTop - m.padBottom)); // escala da imagem para o texto caber
  const capL = m.capL * s, capR = m.capR * s, h = m.height * s, tail = 9;
  const midW = textW + 2 * m.padX * s + 6, W = capL + midW + capR;
  const left = gameScene.add.image(-W / 2, -tail, 'balao', 'balao_l').setOrigin(0, 1).setScale(s);
  const mid = gameScene.add.image(-W / 2 + capL, -tail, 'balao', 'balao_m').setOrigin(0, 1).setDisplaySize(midW, h);
  const right = gameScene.add.image(W / 2 - capR, -tail, 'balao', 'balao_r').setOrigin(0, 1).setScale(s);
  const pointer = gameScene.add.graphics(); // pontinha do balão apontando para quem fala
  pointer.fillStyle(0xe8cf9b, 1).fillTriangle(-6, -tail - 1, 6, -tail - 1, 0, 0);
  pointer.lineStyle(2, 0x7a5230, 1).lineBetween(-6, -tail - 1, 0, 0).lineBetween(6, -tail - 1, 0, 0);
  text.setPosition(0, -tail - h / 2 + 1);
  const box = gameScene.add.container(0, 0, [pointer, mid, left, right, text]).setDepth(10);
  box.setScale(0.6);
  gameScene.tweens.add({ targets: box, scale: 1, duration: 180, ease: 'Back.Out' });
  bubbles[id] = { text: box, half: W / 2, expires: gameScene.time.now + 3000 + message.length * 60 };
}

function updateBubbles(now) {
  for (const id in bubbles) {
    const b = bubbles[id];
    const anchor = id === connection.connectionId ? localSprite : remotePlayers[id]?.rect;
    if (!anchor || now > b.expires) { b.text.destroy(); delete bubbles[id]; continue; }
    b.text.setVisible(anchor.visible);
    b.text.setAlpha(Math.min(1, (b.expires - now) / 300));
    const half = b.half ?? b.text.width / 2;
    b.text.setPosition(Phaser.Math.Clamp(anchor.x, half, WORLD_W - half), anchor.y - BUBBLE_DY - liftFor(id) - shareLift(id));
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
  this.load.image('fundo_arena', 'assets/fundo_arena.jpg');
  this.load.image('placa', 'assets/placa_arena.png');
  this.load.image('fundo_floresta', 'assets/fundo_floresta.jpg');
  this.load.image('placa_floresta', 'assets/placa_floresta.png');
  this.load.image('balao', 'assets/balao.png');
  this.load.json('balaoMeta', 'assets/balao.json');
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
  // placa pequena (menor que um personagem) apontando para a arena, no fim da rua à direita
  signArena = this.add.image(1135, GROUND_TOP, 'placa').setOrigin(0.5, 1).setDisplaySize(97, 58).setDepth(-1);
  signForest = this.add.image(225, GROUND_TOP, 'placa_floresta').setOrigin(0.5, 1).setDisplaySize(97, 58).setDepth(-1);

  // Mapa: só o chão (invisível; a rua desenhada no fundo é o chão visível)
  const platforms = this.physics.add.staticGroup();
  const addPlatform = (x, y, w, h, color) => {
    const r = this.add.rectangle(x, y, w, h, color ?? 0).setVisible(color !== null);
    this.physics.add.existing(r, true);
    platforms.add(r);
  };
  addPlatform(WORLD_W / 2, GROUND_TOP + 20, WORLD_W, 40, null); // chão invisível rente à borda inferior (a calçada de pedra do fundo)

  // Jogador local
  // O corpo físico é um retângulo invisível; a imagem do personagem o acompanha
  player = this.add.rectangle(0, 0, CHAR_W, CHAR_H).setVisible(false);
  localSprite = makeSprite(this, myCharacter);
  this.physics.add.existing(player);
  player.x = 100; player.y = 400;
  player.body.setCollideWorldBounds(true);
  this.physics.add.collider(player, platforms);
  nameLabel = this.add.text(0, 0, myName, LABEL_STYLE).setOrigin(0.5, 1);
  Object.assign(localInfo, { label: nameLabel, name: myName, nameColor: cName.value, title: equippedTitle() });
  refreshLabel(myId());

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
  connection.on('PlayerEmote', (id, i) => showEmote(id, EMOTE_ICONS[i]));
  connection.on('SystemMessage', text => String(text).split('\n').forEach(l => addChatLine(null, l, true)));
  connection.on('PlayerProfile', (id, nameColor, title) => {
    const r = remotePlayers[id];
    if (!r) return;
    r.nameColor = nameColor; r.title = title;
    refreshLabel(id);
  });
  connection.on('Pushed', dir => { pushVX = dir * 520; pushUntil = gameScene.time.now + PUSH_MS; player.body.setVelocityY(-260); });
  connection.on('Riding', onRiding);
  connection.on('PlayerDance', (id, on) => {
    if (id === myId()) localDancing = on;
    else if (remotePlayers[id]) remotePlayers[id].dancing = on;
  });
  connection.on('TagState', onTagState);
  connection.on('TitleEarned', onTitleEarned);
  connection.on('PlayerLeft', id => {
    const r = remotePlayers[id];
    if (!r) return;
    addChatLine(null, r.name + ' saiu', true);
    r.rect.destroy();
    r.label.destroy();
    delete remotePlayers[id];
    delete ridingMap[id];
    voice.members.delete(id);
    closePeer(id);
    dropShare(id);
    renderOnline();
  });

  setupArenaEvents();

  connection.invoke('JoinGame', myName, myCharacter);
  // cor do nome e título (se o servidor for antigo e não tiver o método, ignora o erro)
  connection.invoke('UpdateProfile', localInfo.nameColor, localInfo.title).catch(() => {});
}

function update(time, delta) {
  const body = player.body;
  const typing = document.activeElement === chatInput;
  let left = (!typing && cursors.left.isDown) || touch.left;
  let right = (!typing && cursors.right.isDown) || touch.right;
  let jump = (!typing && cursors.up.isDown) || touch.jump || touch.stickUp;
  if (isCombat() && !arenaMeAlive()) left = right = jump = false; // caído: espera o respawn
  if (!moveHintDone && (left || right || jump)) hideMoveHint();
  const carrierId = ridingMap[myId()];
  const carrier = carrierId && remotePlayers[carrierId];
  if (!carrier) {
    if (left && !right) facing = -1; else if (right && !left) facing = 1;
    safe(() => handleDash(time, left, right));
    if (!body.enable) { body.enable = true; body.reset(player.x, player.y); } // nunca fica "congelado" fora de uma carona
  }

  if (carrier) { // nas costas de alguém: acompanha o carregador; pular desce
    player.setPosition(carrier.rect.x, carrier.rect.y);
    if (jump && !jumpLatch) doRide();
  } else {
    if (time < dashUntil) { // dash: impulso curto, sem gravidade (também vale no ar)
      body.allowGravity = false;
      body.setVelocityX(dashDir * DASH_SPEED);
      body.setVelocityY(0);
    } else {
      body.allowGravity = true;
      if (time < pushUntil) body.setVelocityX(pushVX * (pushUntil - time) / PUSH_MS); // empurrão que vai perdendo força
      else if (left) body.setVelocityX(-200);
      else if (right) body.setVelocityX(200);
      else body.setVelocityX(0);
    }

    if (jump && body.blocked.down) body.setVelocityY(-500);
    if (localDancing && (left || right || jump)) setDancing(false); // andar interrompe a dança
  }
  jumpLatch = jump;
  // um dash contra a borda também conta como "empurrar" a borda (senão soltar a seta logo depois cancelava a troca de mapa)
  const dashing = time < dashUntil + 250;
  safe(() => checkMapEdge(delta, left || (dashing && dashDir < 0), right || (dashing && dashDir > 0), carrier, dashing));

  if (carrier) {
    localSprite.setPosition(player.x, player.y - CHAR_H * 0.72);
    localSprite.animate?.(false, false, 0, delta, localDancing);
  } else {
    localSprite.setPosition(player.x, player.y);
    const vx = body.velocity.x;
    localSprite.animate?.(Math.abs(vx) > 10, !body.blocked.down, vx, delta, localDancing);
  }
  if (!localSprite.animate && localSprite.setAngle) localSprite.angle = localDancing ? Math.sin(Date.now() / 150) * 10 : 0;
  localSprite.setDepth(carrier ? 1 + chainDepth(myId()) : 0);
  placeLabel(nameLabel, localSprite.x, Math.max(localSprite.y - liftFor(myId()), LABEL_MIN_Y));

  // Envia posição só se mudou, com throttle
  if (!carrier && time - lastSent > SEND_INTERVAL_MS &&
      (Math.abs(player.x - lastX) > 0.5 || Math.abs(player.y - lastY) > 0.5)) {
    connection.invoke('UpdatePosition', player.x, player.y);
    lastSent = time; lastX = player.x; lastY = player.y;
  }

  updateBubbles(time);

  // Remotos: interpolação suave, ou posição presa ao carregador quando estão nas costas de alguém
  // (da base da torre para o topo, para cada um já achar o carregador na posição deste quadro)
  for (const id of Object.keys(remotePlayers).sort((a, b) => chainDepth(a) - chainDepth(b))) {
    const r = remotePlayers[id];
    const cId = ridingMap[id];
    const src = cId === myId() ? localSprite : remotePlayers[cId]?.rect;
    r.rect.setDepth(cId ? 1 + chainDepth(id) : 0);
    if (cId && src) {
      r.rect.setPosition(src.x, src.y - RIDE_STEP);
      r.targetX = src.x; r.targetY = src.y;
      r.rect.animate?.(false, false, 0, delta, r.dancing);
    } else {
      const dx = r.targetX - r.rect.x, dy = r.targetY - r.rect.y;
      r.rect.x = Phaser.Math.Linear(r.rect.x, r.targetX, 0.25);
      r.rect.y = Phaser.Math.Linear(r.rect.y, r.targetY, 0.25);
      r.rect.animate?.(Math.abs(dx) > 0.8, Math.abs(dy) > 2, dx, delta, r.dancing);
    }
    if (!r.rect.animate && r.rect.setAngle) r.rect.angle = r.dancing ? Math.sin(Date.now() / 150) * 10 : 0;
    placeLabel(r.label, r.rect.x, Math.max(r.rect.y - liftFor(id), LABEL_MIN_Y));
    syncVisibility(id);
  }
  if (currentMap !== 'arena') updateInteractHint(carrier); else hideInteractHint();
  safe(updateTagFlash);
  safe(updateGifs);
  safe(updateProjections);
  safe(positionChat);
  if (currentMap === 'village') safe(() => updateBackground(this, time));
  safe(updateSlimes);
  safe(updateHeldWeapons);
  safe(drawArenaBars);
  safe(() => updateArrows(delta));
}

// Roda uma rotina secundária do quadro; se ela falhar, o movimento do personagem não para (o erro aparece no console)
const safeSeen = new Set();
function safe(fn) {
  try { fn(); } catch (e) {
    const key = String(e && e.message);
    if (!safeSeen.has(key)) { safeSeen.add(key); console.error('[jogo] erro no quadro:', e); }
  }
}

// ---- Controles de toque (celular) ----
const touch = { left: false, right: false, jump: false, stickUp: false };
document.querySelectorAll('#touch button[data-key]').forEach(btn => {
  const key = btn.dataset.key;
  const set = v => e => { e.preventDefault(); touch[key] = v; };
  btn.addEventListener('pointerdown', set(true));
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, set(false)));
  btn.addEventListener('contextmenu', e => e.preventDefault());
});
const fsBtn = document.getElementById('fsBtn'), fsBtnDesk = document.getElementById('fsBtnDesk'); // celular: acima do chat; computador: ao lado do ?
// Tela cheia (celular e computador). No iPhone o navegador não permite tela cheia em páginas: aparece um aviso.
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (fsElement()) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return say(['⚠️ Este navegador não permite tela cheia aqui. No iPhone, use "Compartilhar → Adicionar à Tela de Início" para abrir o jogo sem barras.']);
  const p = req.call(el);
  if (p && p.then) p.then(() => { if (coarsePointer) screen.orientation?.lock?.('landscape')?.catch?.(() => {}); }).catch(() => say(['⚠️ O navegador recusou a tela cheia. Tente de novo.']));
}
function updateFsIcons() {
  const on = !!fsElement();
  for (const b of [fsBtn, fsBtnDesk]) { b.textContent = on ? '🗗' : '⛶'; b.title = on ? 'Sair da tela cheia' : 'Tela cheia'; }
}
[fsBtn, fsBtnDesk].forEach(b => b.addEventListener('click', toggleFullscreen));
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, updateFsIcons));

// Analógico virtual (celular): arrastar para os lados anda, arrastar para cima pula (o botão ▲ da direita continua valendo)
const stickEl = document.getElementById('stick'), stickKnob = document.getElementById('stickKnob');
const STICK_DEAD = 20, STICK_UP = 26; // px a partir do centro para contar como "esquerda/direita" e "cima"
let stickPointer = null;
function stickMove(e) {
  const r = stickEl.getBoundingClientRect(), max = r.width / 2 - 14;
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  touch.left = dx < -STICK_DEAD; touch.right = dx > STICK_DEAD; touch.stickUp = dy < -STICK_UP;
}
function stickRelease() {
  stickPointer = null;
  stickEl.classList.remove('active');
  stickKnob.style.transform = '';
  touch.left = touch.right = touch.stickUp = false;
}
stickEl.addEventListener('pointerdown', e => {
  e.preventDefault();
  stickPointer = e.pointerId;
  try { stickEl.setPointerCapture(e.pointerId); } catch {}
  stickEl.classList.add('active');
  stickMove(e);
});
stickEl.addEventListener('pointermove', e => { if (e.pointerId === stickPointer) { e.preventDefault(); stickMove(e); } });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => stickEl.addEventListener(ev, e => { if (e.pointerId === stickPointer) stickRelease(); }));
stickEl.addEventListener('contextmenu', e => e.preventDefault());

if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
  document.getElementById('touch').style.display = 'flex';
}

// ---- Chat ----
const chatEl = document.getElementById('chat');
const chatLog = document.getElementById('chatLog');
const OLD_AFTER_MS = 12000; // linhas antigas ficam mais apagadas, como em chats de MMORPG

// Usa textContent (nunca innerHTML) para que mensagens não injetem HTML
// Avisos automáticos do sistema (entrou, bebeu água...) somem sozinhos para não empurrar as conversas: temp = true
const SYS_LIFETIME_MS = 3000;
function addChatLine(name, text, temp = false) {
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
  if (temp && name === null) {
    setTimeout(() => p.classList.add('fading'), SYS_LIFETIME_MS);
    setTimeout(() => p.remove(), SYS_LIFETIME_MS + 1100);
  } else setTimeout(() => p.classList.add('old'), OLD_AFTER_MS);
}

// Dica de movimento: aparece no centro ao entrar e some assim que o jogador começar a andar
const moveHint = document.getElementById('moveHint');
const helpBtn = document.getElementById('helpBtn');
let moveHintDone = false;
function showMoveHint() {
  if (moveHintDone) return;
  moveHint.textContent = coarsePointer ? 'Arraste a bolinha da esquerda para andar (para cima = pular)' : 'Use as setas ← → para andar (↑ para pular)';
  moveHint.hidden = false;
}
function hideMoveHint() {
  moveHintDone = true;
  moveHint.hidden = true;
}

// Mantém o chat DENTRO da área do jogo (canvas), mesmo quando há faixas pretas ao redor
const coarsePointer = matchMedia('(pointer: coarse)').matches;
function positionChat() {
  const r = phaserGame.canvas.getBoundingClientRect();
  onlineEl.style.top = r.top + 8 + 'px';
  onlineEl.style.right = innerWidth - r.right + 8 + 'px';
  emoteTray.style.bottom = innerHeight - r.bottom + 84 + 'px';
  hudEl.style.left = interactHint.style.left = r.left + r.width / 2 + 'px';
  hudEl.style.top = r.top + 8 + 'px';
  interactHint.style.top = r.top + 44 + 'px';
  moveHint.style.left = r.left + r.width / 2 + 'px';
  moveHint.style.top = r.top + r.height / 2 + 'px';
  if (coarsePointer) { arenaRankEl.style.right = innerWidth - r.right + 8 + 'px'; arenaRankEl.style.top = r.top + 48 + 'px'; arenaRankEl.style.left = 'auto'; }
  else { arenaRankEl.style.left = r.left + 12 + 'px'; arenaRankEl.style.top = r.top + 8 + 'px'; }
  arenaBarEl.style.left = r.left + r.width / 2 + 'px';
  arenaBarEl.style.top = r.top + 8 + 'px'; // no alto, para não cobrir os personagens na calçada
  arenaMsgEl.style.left = r.left + r.width / 2 + 'px';
  arenaMsgEl.style.top = r.top + r.height * 0.38 + 'px';
  fsBtnDesk.style.right = innerWidth - r.right + 12 + 44 + 'px';
  fsBtnDesk.style.bottom = innerHeight - r.bottom + 12 + 'px';
  helpBtn.style.right = innerWidth - r.right + 12 + 'px';
  helpBtn.style.bottom = innerHeight - r.bottom + (coarsePointer ? 108 : 12) + 'px'; // no celular fica acima dos botões de toque
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
  onlineEl.hidden = false;
  if (coarsePointer) onlineEl.classList.add('closed'); // no celular começa recolhido
  renderOnline();
  connection.on('ChatHistory', list => list.forEach(m => addChatLine(m.name, m.text)));
  connection.on('ChatMessage', m => {
    // primeiro o som: nada pode impedi-lo. Mensagem de amigo = "ding-dong"; a sua própria = um "blip" curto de envio
    try { if (m.id !== myId()) playPing(); else playSend(); } catch (e) { console.warn('[som] aviso do chat falhou', e); }
    addChatLine(m.name, m.text);
    showBubble(m.id, m.text);
  });
  setupVoiceEvents();
  setupShareEvents();
  setupHelp();
  chatReady = true;
  // depois do histórico, que chega logo ao entrar
  setTimeout(() => addChatLine(null, `👋 Bem-vindo, ${myName}! Digite /comandos para ver tudo que você pode fazer.`, true), 700);
  showMoveHint();
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
  if (text) {
    if (text.startsWith('/')) runCommand(text);
    else connection.invoke('SendMessage', text);
  }
  closeChatBar();
});
document.getElementById('talkBtn').addEventListener('click', () => { if (chatReady) openChatBar(); });

// ---- Boneco montado com as imagens (peças recortadas, recoloridas por zona de cor) ----
// As imagens originais usam cores-chave: pele = laranja, cabelo = azul, roupa = verde.
// Cada pixel dessas zonas troca de matiz/cor pela escolha do usuário, mantendo o sombreado.
// Posições/pivôs das peças vêm de assets/dolls.json (gerado por tools/build-doll-assets.js).
const ASSET_DIR = 'assets/';
const DOLL_ART_VERSION = 2; // aumente quando as imagens do boneco mudarem (senão o navegador usa a arte antiga do cache)
let dollLayout = null;
const dollImages = {};
const dollAssetsReady = (async () => {
  dollLayout = await (await fetch(ASSET_DIR + 'dolls.json?v=' + DOLL_ART_VERSION)).json();
  await Promise.all(Object.values(dollLayout).flat().map(p => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { dollImages[p.file] = img; resolve(); };
    img.onerror = reject;
    img.src = ASSET_DIR + p.file + '?v=' + DOLL_ART_VERSION;
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
    const zone = ZONES.find(z => h >= z.from && h <= z.to);
    if (!zone) continue;
    // O homem usa arte nova (pixel art) com mais cores: couro marrom (cinto/bolsa), cota de malha cinza, botas e contorno azul-marinho
    const male = !cfg.female;
    const minSat = male && zone.key === 'cloth' ? 0.22 : 0.4; // verdes mais apagados da roupa também mudam
    if (sat < minSat || l < 0.1) continue; // contorno, cinza (sapatos, malha), branco dos olhos: não mexe
    if (male && zone.key === 'skin' && (h < 24 || sat < 0.7)) continue; // o marrom do couro não é pele
    if (male && zone.key === 'hair' && l < 0.2) continue; // o contorno escuro continua escuro
    const [th, ts, tl] = target[zone.key];
    const base = male && zone.key === 'hair' ? 0.38 : zone.base;
    const nl = Math.max(0.04, Math.min(0.96, tl + (l - base)));
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

// Armas na mão do boneco (desenhadas por código, apontando para cima a partir da mão; unidades do boneco, antes da escala)
const WEAPON_TILT = [0.8, 0.55, 0.2, 0.65, 0.95]; // inclinação de cada arma na mão (rad): espada, lança, arco, martelo, garras
function drawWeapon(g, kind) {
  const line = (w, c, x0, y0, x1, y1) => g.lineStyle(w, c, 1).lineBetween(x0, y0, x1, y1);
  if (kind === 0) { // espada
    line(2.8, 0x1b1b1b, 0, 2, 0, -17.5);
    line(1.7, 0xdfe8f2, 0, -3.5, 0, -17);
    g.fillStyle(0xdfe8f2, 1).fillTriangle(-1.3, -17, 1.3, -17, 0, -20.5);
    line(3.4, 0x1b1b1b, -4, -3, 4, -3); line(2.2, 0xe0a82e, -3.6, -3, 3.6, -3); // guarda
    line(2.4, 0x1b1b1b, 0, 2.5, 0, -2.5); line(1.4, 0x7a4524, 0, 2.2, 0, -2.4); // cabo
  } else if (kind === 1) { // lança
    line(2.2, 0x1b1b1b, 0, 9, 0, -23); line(1.3, 0x9a6a38, 0, 9, 0, -23);
    g.fillStyle(0x1b1b1b, 1).fillTriangle(-3, -22, 3, -22, 0, -31);
    g.fillStyle(0xdfe8f2, 1).fillTriangle(-2.1, -22.5, 2.1, -22.5, 0, -29.5);
  } else if (kind === 2) { // arco
    const a0 = Math.PI * 0.62, a1 = Math.PI * 1.38, cx = 5, cy = -8, r = 11;
    g.lineStyle(3, 0x1b1b1b, 1).beginPath().arc(cx, cy, r, a0, a1).strokePath();
    g.lineStyle(1.7, 0x9a6a38, 1).beginPath().arc(cx, cy, r, a0, a1).strokePath();
    line(0.8, 0xffffff, cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r); // corda
  } else if (kind === 3) { // martelo
    line(2.8, 0x1b1b1b, 0, 6, 0, -14); line(1.7, 0x9a6a38, 0, 6, 0, -14);
    g.fillStyle(0x1b1b1b, 1).fillRect(-6.8, -21.5, 13.6, 9.4);
    g.fillStyle(0x8e98a4, 1).fillRect(-6, -20.7, 12, 7.8);
    g.fillStyle(0xdfe8f2, 1).fillRect(-6, -20.7, 12, 2.2);
  } else { // garras: três lâminas curvas presas a uma luva
    for (const ox of [-3.2, 0, 3.2]) {
      line(2.6, 0x1b1b1b, ox, 0, ox * 1.7, -13);
      line(1.4, 0xe8eef5, ox, -0.5, ox * 1.7, -12.4);
    }
    line(3.6, 0x1b1b1b, -4.6, 1, 4.6, 1); line(2.4, 0x7a3b1c, -4.2, 1, 4.2, 1);
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
  const doll = scene.add.container(0, 0, [rig]).setScale(CHAR_SCALE);
  let phase = 0, dir = 1;

  // Arma na mão (desenhada por código): o suporte gira junto com o braço da frente; a arma fica na ponta do braço
  const hand = scene.add.container(part.armNear.x, part.armNear.y).setVisible(false);
  const weaponG = scene.add.graphics().setPosition(0, 15);
  hand.add(weaponG);
  rig.add(hand);
  let weaponKind = null, swing = 0;
  doll.setWeapon = kind => {
    if (kind === weaponKind) return;
    weaponKind = kind;
    weaponG.clear();
    hand.setVisible(kind !== null && kind !== undefined);
    if (kind !== null && kind !== undefined) drawWeapon(weaponG, kind);
  };
  doll.swingWeapon = () => { swing = 1; }; // o braço dá a "golpeada" na próxima animação

  doll.animate = (moving, air, vx, dt = 16, dancing = false) => {
    if (Math.abs(vx) > 0.5) dir = vx > 0 ? 1 : -1;
    doll.scaleX = dir * CHAR_SCALE;
    let aN = 0, aF = 0, lN = 0, lF = 0, bob = 0;
    let sway = 0;
    if (dancing) { // a fase vem do relógio, então todo mundo que dança fica em sincronia
      const ph = Date.now() / 1000 * Math.PI * 2 * 1.6;
      dir = Math.floor(Date.now() / 2500) % 2 ? 1 : -1;
      doll.scaleX = dir * CHAR_SCALE;
      aN = -2.3 + Math.sin(ph) * 0.6; aF = -2.3 - Math.sin(ph) * 0.6;
      lN = Math.sin(ph) * 0.5; lF = -Math.sin(ph) * 0.5;
      bob = -Math.abs(Math.sin(ph)) * 3.5; sway = Math.sin(ph / 2) * 0.1;
    }
    else if (air) { lN = -0.7; lF = 0.5; aN = -2.3; aF = -1.9; }
    else if (moving) {
      phase += dt * 0.014;
      const sw = Math.sin(phase);
      lN = sw * 0.8; lF = -sw * 0.8; aN = -sw * 0.9; aF = sw * 0.9;
      bob = -Math.abs(Math.cos(phase)) * 1.2;
    } else {
      bob = Math.sin(scene.time.now * 0.004) * 0.4;
    }
    if (swing > 0) { // golpe: o braço levanta e desce rápido
      aN = -2.0 + (1 - swing) * 1.8;
      swing = Math.max(0, swing - dt / 260);
    }
    const k = 1 - Math.exp(-dt * 0.02); // suaviza a transição entre poses
    const ease = (obj, target) => { obj.rotation += (target - obj.rotation) * k; };
    ease(part.armNear, aN); ease(part.armFar, aF);
    if (weaponKind !== null) { hand.rotation = part.armNear.rotation; weaponG.rotation = WEAPON_TILT[weaponKind] ?? 0.7; }
    ease(part.legNear, lN); ease(part.legFar, lF);
    rig.y += (bob - rig.y) * k;
    rig.rotation += (sway - rig.rotation) * k;
  };
  doll.setRedFlash = on => {
    for (const [id, img] of Object.entries(part)) {
      if (on) img.setTintFill(0xff0000);
      else if (id.endsWith('Far')) img.setTint(0xc8c8c8); // volta ao tom mais escuro dos membros de trás
      else img.clearTint();
    }
  };
  return doll;
}

// Pegador do pique-pega: o corpo inteiro pisca em vermelho (boneco, imagem estática ou GIF)
const RED_FILTER = 'brightness(0) saturate(100%) invert(15%) sepia(100%) saturate(7500%) hue-rotate(-8deg)';
function setRedFlash(sprite, on) {
  if (!sprite) return;
  if (sprite.setRedFlash) return sprite.setRedFlash(on);
  for (const g of gifSprites) if (g.sprite === sprite) { g.img.style.filter = on ? RED_FILTER : ''; return; }
  if (on) sprite.setTintFill(0xff0000); else sprite.clearTint();
}
const flashState = {}; // id -> último estado aplicado (só mexe no sprite quando muda)
function updateTagFlash() {
  const phaseOn = Math.floor(Date.now() / 125) % 2 === 0;
  const apply = (id, sprite) => {
    const on = isIt(id) && phaseOn;
    if (!!flashState[id] === on) return;
    flashState[id] = on;
    setRedFlash(sprite, on);
  };
  apply(myId(), localSprite);
  for (const id in remotePlayers) apply(id, remotePlayers[id].rect);
  for (const id in flashState) if (id !== myId() && !remotePlayers[id]) delete flashState[id];
}

// ---- Lembrar nome e aparência neste navegador ----
// Guarda nome, gênero e cores (e a imagem estática enviada, que é pequena). GIFs animados
// não são guardados: dependem do arquivo, então é só escolher de novo.
function saveProfile() {
  try {
    const gender = document.querySelector('input[name=gender]:checked').value;
    localStorage.setItem('profile', JSON.stringify({
      name: myName === 'Jogador' && !document.getElementById('name').value.trim() ? '' : myName,
      gender, hair: cHair.value, skin: cSkin.value, cloth: cCloth.value, nameColor: cName.value,
      image: customImage && !customImage.startsWith('data:image/gif') ? customImage : null,
    }));
  } catch {}
}

function restoreProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('profile') || 'null');
    if (!p) return;
    const hex = v => (/^#[0-9a-f]{6}$/i.test(v) ? v : null);
    if (typeof p.name === 'string') document.getElementById('name').value = p.name.slice(0, 16);
    const radio = document.querySelector(`input[name=gender][value="${p.gender === 'f' ? 'f' : 'm'}"]`);
    if (radio) radio.checked = true;
    cHair.value = hex(p.hair) || cHair.value;
    cSkin.value = hex(p.skin) || cSkin.value;
    cCloth.value = hex(p.cloth) || cCloth.value;
    cName.value = hex(p.nameColor) || cName.value;
    if (typeof p.image === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) && p.image.length <= MAX_IMAGE_CHARS) {
      customImage = p.image;
      preview.src = customImage;
      preview.hidden = false;
      dollPreview.hidden = true;
    }
  } catch {}
}
const cHair = document.getElementById('cHair'), cSkin = document.getElementById('cSkin'), cCloth = document.getElementById('cCloth');
const cName = document.getElementById('cName');
restoreProfile();
drawDollPreview(document.getElementById('dollPreview'), currentDollConfig());

// ---- Lista de online ----
const onlineEl = document.getElementById('online');
function renderOnline() {
  const list = document.getElementById('onlineList');
  const names = [{ name: myName + ' (você)' + (voice.on ? ' 🎧' : ''), me: true },
    ...Object.entries(remotePlayers).map(([id, r]) => ({ name: r.name + (voice.members.has(id) ? ' 🎧' : '') }))];
  list.replaceChildren(...names.map(n => {
    const li = document.createElement('li');
    li.textContent = n.name; // textContent: nomes nunca viram HTML
    if (n.me) li.className = 'me';
    return li;
  }));
  document.getElementById('onlineCount').textContent = names.length;
}
document.getElementById('onlineToggle').addEventListener('click', () => onlineEl.classList.toggle('closed'));

// ---- Emotes (teclas 1–6 no PC, bandeja no celular) ----
const EMOTES = ['👋', '😂', '❤️', '👍', '😮', '😢'];
let lastEmoteAt = 0;

function showEmote(id, emoji) {
  if (!gameScene || !emoji) return;
  bubbles[id]?.text.destroy();
  const text = gameScene.add.text(0, 0, emoji, { fontSize: '34px', fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif', padding: { x: 4, top: 10, bottom: 6 } }).setOrigin(0.5, 1).setDepth(10);
  bubbles[id] = { text, expires: gameScene.time.now + 2500 };
}

function sendEmote(i) {
  const now = Date.now();
  if (!chatReady || now - lastEmoteAt < 500) return;
  lastEmoteAt = now;
  showEmote(connection.connectionId, EMOTES[i]); // aparece na hora para quem enviou
  connection.invoke('Emote', i);
}

window.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !chatBar.hidden || isCombat()) return; // nos mapas de combate 1–5 trocam de arma
  if (e.key >= '1' && e.key <= String(EMOTES.length)) sendEmote(Number(e.key) - 1);
});

const emoteTray = document.getElementById('emoteTray');
EMOTES.forEach((emoji, i) => {
  const b = document.createElement('button');
  b.textContent = emoji;
  b.addEventListener('click', () => { sendEmote(i); emoteTray.classList.remove('open'); });
  emoteTray.appendChild(b);
});
document.getElementById('emoteBtn').addEventListener('click', () => emoteTray.classList.toggle('open'));

// ---- Música ambiente gerada por código (nenhum arquivo de áudio) ----
// muted = música (ambiente e de dança); sfxMuted = efeitos (avisos, golpes, dano, dash). Cada um tem seu botão.
const music = { ctx: null, master: null, bus: null, timer: null, step: 0, muted: false, sfxMuted: false };
try { music.muted = localStorage.getItem('muted') === '1'; music.sfxMuted = localStorage.getItem('sfxMuted') === '1'; } catch {}
const muteBtn = document.getElementById('muteBtn');
const sfxBtn = document.getElementById('sfxBtn');
muteBtn.textContent = music.muted ? '🔇' : '🎵';
sfxBtn.textContent = music.sfxMuted ? '🔕' : '🔊';

// Cada período do dia tem seu clima: acordes (notas MIDI) e duração do compasso em segundos
const MOODS = {
  10: { bar: 8, chords: [[60, 64, 67], [65, 69, 72], [67, 71, 74], [57, 60, 64]] },  // manhã: claro, Dó maior
  15: { bar: 9, chords: [[65, 69, 72], [60, 64, 67], [62, 65, 69], [58, 62, 65]] },  // tarde: quente, Fá maior
  18: { bar: 10, chords: [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]] }, // noite: calmo, Lá menor
};
const MUSIC_VOLUME = 0.125; // volume geral da música (0 a 1)
const midiFreq = n => 440 * Math.pow(2, (n - 69) / 12);

function unlockAudio() {
  try {
    if (!music.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = music.ctx = new Ctx();
      music.master = ctx.createGain();
      music.master.gain.value = music.muted ? 0 : MUSIC_VOLUME;
      music.master.connect(ctx.destination);
      music.sfx = ctx.createGain(); // efeitos sonoros (volume próprio)
      music.sfx.gain.value = music.sfxMuted ? 0 : 0.5;
      music.sfx.connect(ctx.destination);
      // eco suave para dar ambiente
      const delay = ctx.createDelay(1), feedback = ctx.createGain(), wet = ctx.createGain();
      delay.delayTime.value = 0.42; feedback.gain.value = 0.35; wet.gain.value = 0.35;
      music.bus = ctx.createGain();
      music.bus.connect(music.master);
      music.bus.connect(delay); delay.connect(feedback); feedback.connect(delay);
      delay.connect(wet); wet.connect(music.master);
    }
    if (music.ctx.state === 'suspended') music.ctx.resume();
  } catch {}
}
// se o navegador ainda não liberou o áudio, tenta de novo no próximo toque/tecla
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, unlockAudio));

function tone(freq, start, dur, type, gain, attack) {
  const ctx = music.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(gain, start + attack);
  g.gain.linearRampToValueAtTime(0.0001, start + dur);
  osc.connect(g); g.connect(music.bus);
  osc.start(start); osc.stop(start + dur + 0.1);
}

function playBar() {
  const ctx = music.ctx;
  if (!ctx || ctx.state !== 'running') return;
  const mood = MOODS[backgroundPeriod] || MOODS[10];
  const chord = mood.chords[music.step++ % mood.chords.length];
  const t0 = ctx.currentTime + 0.05, len = mood.bar;
  for (const n of chord) tone(midiFreq(n - 12), t0, len + 3, 'triangle', 0.045, 2.5); // base suave
  tone(midiFreq(chord[0] - 24), t0, len + 1, 'sine', 0.06, 1.5);                       // grave
  const notes = Math.round(len * 0.8);                                                  // notas soltas
  for (let i = 0; i < notes; i++) {
    const at = t0 + (i + Math.random() * 0.6) * (len / notes);
    const n = chord[Math.floor(Math.random() * chord.length)] + 12 * (1 + Math.floor(Math.random() * 2));
    tone(midiFreq(n), at, 2.2, 'sine', 0.05, 0.02);
  }
}

function startMusic() {
  if (music.timer || !music.ctx) return;
  const loop = () => {
    playBar();
    music.timer = setTimeout(loop, (MOODS[backgroundPeriod] || MOODS[10]).bar * 1000);
  };
  loop();
}

// ---- Música animada enquanto alguém dança (sintetizada, ~124 bpm) ----
// Enquanto houver dança: a música calma abaixa e entra uma batida alegre (bumbo, chimbal, baixo e melodia pentatônica).
const DANCE_BPM = 124, DANCE_STEP_S = 60 / DANCE_BPM / 2; // colcheias
const DANCE_BASS = [45, 45, 52, 45, 48, 48, 55, 48]; // Lá, Lá, Mi, Lá | Dó, Dó, Sol, Dó (uma nota por colcheia)
const DANCE_PENTA = [69, 72, 74, 76, 79, 81]; // Lá menor pentatônica
const DANCE_MELODY = [0, -1, 2, 3, -1, 4, 3, 2, 1, -1, 3, 4, 5, 4, 2, -1]; // índice em DANCE_PENTA (-1 = pausa)
const danceMusic = { timer: null, step: 0, nextAt: 0, on: false, noise: null };

function danceTone(freq, t, dur, type, gain) {
  const ctx = music.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g); g.connect(music.master);
  osc.start(t); osc.stop(t + dur + 0.05);
}

function danceStep(t, i) {
  const ctx = music.ctx, s = i % 16;
  if (s % 4 === 0) { // bumbo a cada tempo
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t); osc.frequency.exponentialRampToValueAtTime(45, t + 0.14);
    g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(g); g.connect(music.master); osc.start(t); osc.stop(t + 0.22);
  }
  if (s % 2 === 1) { // chimbal nos contratempos
    if (!danceMusic.noise) {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate), d = buf.getChannelData(0);
      for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
      danceMusic.noise = buf;
    }
    const src = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = danceMusic.noise; hp.type = 'highpass'; hp.frequency.value = 7000;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.connect(hp); hp.connect(g); g.connect(music.master); src.start(t); src.stop(t + 0.1);
  }
  danceTone(midiFreq(DANCE_BASS[Math.floor(i / 2) % DANCE_BASS.length] + (s % 2 ? 12 : 0)), t, DANCE_STEP_S * 0.9, 'triangle', 0.16);
  const m = DANCE_MELODY[s];
  if (m >= 0) danceTone(midiFreq(DANCE_PENTA[m]), t, DANCE_STEP_S * 1.6, 'square', 0.05);
}

function danceLoop() {
  const ctx = music.ctx;
  if (!danceMusic.on || !ctx) return;
  if (ctx.state === 'running') {
    if (danceMusic.nextAt < ctx.currentTime) danceMusic.nextAt = ctx.currentTime + 0.05;
    while (danceMusic.nextAt < ctx.currentTime + 0.3) { // agenda um pouco à frente
      danceStep(danceMusic.nextAt, danceMusic.step++);
      danceMusic.nextAt += DANCE_STEP_S;
    }
  }
  danceMusic.timer = setTimeout(danceLoop, 80);
}

// a música calma abaixa enquanto toca a de dança ou a de batalha
const duckAmbient = () => { if (music.bus) music.bus.gain.setTargetAtTime(forestMusic.on ? 0 : danceMusic.on || battleMusic.on ? 0.12 : 1, music.ctx.currentTime, 0.4); };
function setDanceMusic(on) {
  if (danceMusic.on === on || !music.ctx) return;
  danceMusic.on = on;
  duckAmbient();
  if (on) { danceMusic.step = 0; danceMusic.nextAt = 0; danceLoop(); }
  else { clearTimeout(danceMusic.timer); danceMusic.timer = null; }
}
const anyoneDancing = () => localDancing || Object.values(remotePlayers).some(r => r.dancing && r.map === currentMap);

// ---- Música de batalha da arena (chiptune 16 bits, ~152 bpm, Lá menor) ----
// Bumbo e caixa, chimbal, baixo em oitavas, arpejo em onda quadrada e uma nota longa de destaque no início de cada compasso.
const BATTLE_STEP_S = 60 / 152 / 4; // semicolcheias
const BATTLE_PROG = [[45, [0, 3, 7]], [41, [0, 4, 7]], [48, [0, 4, 7]], [43, [0, 4, 7]], [45, [0, 3, 7]], [41, [0, 4, 7]], [43, [0, 4, 7]], [40, [0, 4, 7, 10]]]; // Am F C G | Am F G E7
const BATTLE_ARP = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, 3];
const battleMusic = { timer: null, step: 0, nextAt: 0, on: false, noise: null };

function battleNoise(t, dur, gain, type, cutoff) {
  const ctx = music.ctx;
  if (!battleMusic.noise) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate), d = buf.getChannelData(0);
    for (let k = 0; k < d.length; k += 2) d[k] = d[k + 1] = Math.random() * 2 - 1; // ruído "áspero" de chip de som
    battleMusic.noise = buf;
  }
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = battleMusic.noise; f.type = type; f.frequency.value = cutoff;
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(music.master); src.start(t); src.stop(t + dur + 0.02);
}

function battleStep(t, i) {
  const ctx = music.ctx, bar = Math.floor(i / 16) % BATTLE_PROG.length, s = i % 16;
  const [root, tri] = BATTLE_PROG[bar];
  if (s === 0 || s === 8 || (s === 10 && bar % 2)) { // bumbo
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); g.connect(music.master); o.start(t); o.stop(t + 0.2);
  }
  if (s === 4 || s === 12) battleNoise(t, 0.12, 0.3, 'bandpass', 1800); // caixa
  if (s % 2 === 0) battleNoise(t, 0.04, s % 4 === 0 ? 0.1 : 0.06, 'highpass', 7500); // chimbal
  if (s % 2 === 0) danceTone(midiFreq(root + (s % 4 === 2 ? 12 : 0)), t, BATTLE_STEP_S * 1.7, 'triangle', 0.2); // baixo em oitavas
  const k = BATTLE_ARP[s];
  danceTone(midiFreq(root + 24 + tri[k % tri.length] + 12 * Math.floor(k / tri.length)), t, BATTLE_STEP_S * 1.5, 'square', 0.055); // arpejo
  if (s === 0) danceTone(midiFreq(root + 36 + tri[bar % tri.length]), t, BATTLE_STEP_S * 4, 'square', 0.05); // destaque
  if (bar >= 4 && s % 4 === 3) danceTone(midiFreq(root + 31 + tri[(bar + s) % tri.length]), t, BATTLE_STEP_S * 1.2, 'square', 0.04); // contracanto na 2ª metade
}

function battleLoop() {
  const ctx = music.ctx;
  if (!battleMusic.on || !ctx) return;
  if (ctx.state === 'running') {
    if (battleMusic.nextAt < ctx.currentTime) battleMusic.nextAt = ctx.currentTime + 0.05;
    while (battleMusic.nextAt < ctx.currentTime + 0.3) {
      battleStep(battleMusic.nextAt, battleMusic.step++);
      battleMusic.nextAt += BATTLE_STEP_S;
    }
  }
  battleMusic.timer = setTimeout(battleLoop, 80);
}

function setBattleMusic(on) {
  if (battleMusic.on === on || !music.ctx) return;
  battleMusic.on = on;
  duckAmbient();
  if (on) { battleMusic.step = 0; battleMusic.nextAt = 0; battleLoop(); }
  else { clearTimeout(battleMusic.timer); battleMusic.timer = null; }
}

// ---- Trilha heroica da floresta (~92 bpm, Ré maior): tímpanos, cordas e trompas em fanfarra, em 16 bits ----
const FOREST_STEP_S = 60 / 92 / 4; // semicolcheias
const FOREST_PROG = [ // [baixo, acorde (MIDI)]: D A Bm G | D A G A
  [38, [62, 66, 69]], [45, [61, 64, 69]], [47, [62, 66, 71]], [43, [59, 62, 67]],
  [38, [62, 66, 69]], [45, [61, 64, 69]], [43, [59, 62, 67]], [45, [61, 64, 69]],
];
const FOREST_MELODY = [ // por compasso: [passo, nota MIDI, duração em passos] — a "fanfarra" da trompa
  [[0, 74, 4], [4, 81, 2], [6, 79, 2], [8, 78, 4], [12, 74, 4]],
  [[0, 73, 4], [4, 76, 4], [8, 81, 6], [14, 79, 2]],
  [[0, 74, 4], [4, 78, 2], [6, 79, 2], [8, 81, 4], [12, 78, 4]],
  [[0, 79, 4], [4, 78, 2], [6, 76, 2], [8, 74, 8]],
  [[0, 74, 2], [2, 78, 2], [4, 81, 4], [8, 86, 8]],
  [[0, 85, 4], [4, 81, 4], [8, 79, 4], [12, 76, 4]],
  [[0, 79, 4], [4, 83, 4], [8, 86, 4], [12, 83, 4]],
  [[0, 85, 6], [6, 81, 2], [8, 76, 4], [12, 73, 2], [14, 76, 2]],
];
const forestMusic = { timer: null, step: 0, nextAt: 0, on: false };

function forestPad(freq, t, dur, gain) { // cordas: serra suave com entrada lenta
  const ctx = music.ctx, g = ctx.createGain(), lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1500;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.35); g.gain.setValueAtTime(gain, t + dur - 0.3); g.gain.linearRampToValueAtTime(0.0001, t + dur);
  lp.connect(g); g.connect(music.master);
  for (const det of [-6, 6]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
    o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
  }
}

function forestHorn(freq, t, dur, gain) { // trompa: serra com vibrato
  const ctx = music.ctx, o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), depth = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.value = freq;
  lp.type = 'lowpass'; lp.frequency.value = 2600;
  lfo.frequency.value = 5.5; depth.gain.value = freq * 0.008; lfo.connect(depth); depth.connect(o.frequency);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.04); g.gain.setValueAtTime(gain * 0.8, t + dur * 0.6); g.gain.linearRampToValueAtTime(0.0001, t + dur);
  o.connect(lp); lp.connect(g); g.connect(music.master);
  o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
}

function forestStep(t, i) {
  const ctx = music.ctx, bar = Math.floor(i / 16) % FOREST_PROG.length, s = i % 16;
  const [bass, chord] = FOREST_PROG[bar];
  if (s === 0) chord.forEach(n => forestPad(midiFreq(n), t, FOREST_STEP_S * 16, 0.03)); // acorde sustentado
  if (s === 0 || s === 8) { // tímpano
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.3);
    g.gain.setValueAtTime(s === 0 ? 0.75 : 0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(music.master); o.start(t); o.stop(t + 0.55);
  }
  if (s === 4 || s === 12) battleNoise(t, 0.09, 0.16, 'bandpass', 1500); // caixa de marcha, baixinha
  if (s % 4 === 0) danceTone(midiFreq(bass + (s % 8 === 4 ? 12 : 0)), t, FOREST_STEP_S * 3.6, 'triangle', 0.2); // baixo marcado
  for (const [at, note, len] of FOREST_MELODY[bar]) if (at === s) forestHorn(midiFreq(note), t, FOREST_STEP_S * len * 0.95, 0.07);
  if (bar % 4 === 3 && s === 14) { // pequena virada de tímpanos antes de repetir
    for (let k = 0; k < 2; k++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), tt = t + k * FOREST_STEP_S * 0.5;
      o.frequency.setValueAtTime(95, tt); o.frequency.exponentialRampToValueAtTime(55, tt + 0.2);
      g.gain.setValueAtTime(0.4, tt); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.25);
      o.connect(g); g.connect(music.master); o.start(tt); o.stop(tt + 0.3);
    }
  }
}

function forestLoop() {
  const ctx = music.ctx;
  if (!forestMusic.on || !ctx) return;
  if (ctx.state === 'running') {
    if (forestMusic.nextAt < ctx.currentTime) forestMusic.nextAt = ctx.currentTime + 0.05;
    while (forestMusic.nextAt < ctx.currentTime + 0.3) {
      forestStep(forestMusic.nextAt, forestMusic.step++);
      forestMusic.nextAt += FOREST_STEP_S;
    }
  }
  forestMusic.timer = setTimeout(forestLoop, 80);
}

function setForestMusic(on) {
  if (forestMusic.on === on || !music.ctx) return;
  forestMusic.on = on;
  duckAmbient();
  if (on) { forestMusic.step = 0; forestMusic.nextAt = 0; forestLoop(); }
  else { clearTimeout(forestMusic.timer); forestMusic.timer = null; }
}

// cada mapa tem a sua música: vilarejo (calma, ou a de dança), floresta (heroica) e arena (batalha)
setInterval(() => {
  const arena = currentMap === 'arena' && !music.muted;
  const forest = currentMap === 'forest' && !music.muted;
  setBattleMusic(arena);
  setForestMusic(forest);
  setDanceMusic(!arena && !forest && anyoneDancing());
}, 400);

muteBtn.addEventListener('click', () => {
  music.muted = !music.muted;
  muteBtn.textContent = music.muted ? '🔇' : '🎵';
  try { localStorage.setItem('muted', music.muted ? '1' : '0'); } catch {}
  unlockAudio();
  if (music.master) music.master.gain.setTargetAtTime(music.muted ? 0 : MUSIC_VOLUME, music.ctx.currentTime, 0.15);
});

// 🔊/🔕: efeitos sonoros (golpes, dano, dash, avisos de chat e de entrada) ligados/desligados à parte da música
sfxBtn.addEventListener('click', () => {
  music.sfxMuted = !music.sfxMuted;
  sfxBtn.textContent = music.sfxMuted ? '🔕' : '🔊';
  try { localStorage.setItem('sfxMuted', music.sfxMuted ? '1' : '0'); } catch {}
  unlockAudio();
  if (music.sfx) music.sfx.gain.setTargetAtTime(music.sfxMuted ? 0 : 0.5, music.ctx.currentTime, 0.05);
});

// ======================= Ações sociais, comandos, pique-pega e títulos =======================
const EMOTE_ICONS = { ...EMOTES, 6: '🖐️', 7: '🤝', 8: '💢', 9: '🎵', 20: '💧', 21: '🍞', 22: '🔨', 23: '🍎', 24: '🧀', 25: '🍅', 26: '🚪' };

let localDancing = false, jumpLatch = false, pushVX = 0, pushUntil = 0;
const PUSH_MS = 350;
let tagState = { active: false }, tagEndsAt = 0;
const hudEl = document.getElementById('hud');
const interactHint = document.getElementById('interactHint');

// Pontos do vilarejo (x no mundo de 1280 de largura). A ordem é a mesma do servidor.
const SPOTS = [
  { x: 798, range: 110, text: 'Beber água na fonte' },
  { x: 1220, range: 70, text: 'Comprar pão na padaria' },
  { x: 1041, range: 60, text: 'Bater o martelo na ferraria' },
  { x: 335, range: 60, text: 'Olhar as frutas da barraca' },
  { x: 486, range: 55, text: 'Provar o queijo da barraca' },
  { x: 598, range: 55, text: 'Comprar tomates na barraca' },
  { x: 122, range: 55, text: 'Bater na porta' },
];
let currentSpot = -1, lastHintKey = null, currentShareTarget = null;

function updateInteractHint(riding) {
  const target = riding ? null : nearestSharer(); // uma transmissão por perto tem prioridade sobre os pontos do vilarejo
  const spot = riding || target || currentMap !== 'village' ? -1 : SPOTS.findIndex(sp => Math.abs(player.x - sp.x) < sp.range);
  const key = target ? 'share:' + target + (share.views[target] ? ':on' : '') : spot;
  if (key === lastHintKey) return;
  lastHintKey = key;
  currentSpot = spot;
  currentShareTarget = target;
  interactHint.hidden = spot < 0 && !target;
  const pre = coarsePointer ? '👆 Toque: ' : 'Aperte E: ';
  const name = target && (remotePlayers[target]?.name || 'alguém');
  if (target) interactHint.textContent = pre + (share.views[target] ? 'Ampliar a transmissão de ' : 'Assistir à transmissão de ') + name;
  else if (spot >= 0) interactHint.textContent = pre + SPOTS[spot].text;
}

const doGreet = () => connection.invoke('Greet');
const doPush = () => connection.invoke('Push');
const doRide = () => connection.invoke('ToggleRide');
const setDancing = on => { localDancing = on; connection.invoke('SetDancing', on); };
const doDance = () => setDancing(!localDancing); // também vale nas costas de alguém (torre)
const doInteract = () => {
  if (currentShareTarget) return interactShare(currentShareTarget);
  if (currentSpot >= 0) connection.invoke('Interact', currentSpot);
  else addChatLine(null, 'Chegue perto de um ponto do vilarejo (fonte, barracas, padaria, ferraria, porta) ou de uma projeção de tela.');
};
interactHint.addEventListener('click', doInteract);

// Quem sobe/desce das costas de alguém
function onRiding(rid, cid, x, y) {
  if (cid) ridingMap[rid] = cid; else delete ridingMap[rid];
  const me = rid === myId();
  const sprite = me ? localSprite : remotePlayers[rid]?.rect;
  sprite?.setDepth(cid ? 2 : 0);
  if (me) {
    if (cid) { player.body.enable = false; player.body.setVelocity(0, 0); }
    else { player.body.enable = true; player.body.reset(x, y); }
  } else if (!cid && remotePlayers[rid]) {
    Object.assign(remotePlayers[rid], { targetX: x, targetY: y });
  }
}

// ---- Pique-pega: placar no topo e pegador em vermelho ----
function onTagState(st) {
  tagState = st;
  tagEndsAt = Date.now() + (st.remainingMs || 0);
  refreshAllLabels();
  updateHud();
}
function updateHud() {
  if (!tagState.active) { hudEl.hidden = true; return; }
  const secs = Math.max(0, Math.ceil((tagEndsAt - Date.now()) / 1000));
  const who = tagState.itId === myId() ? 'VOCÊ É O PEGADOR!' : 'Pegador: ' + tagState.itName;
  hudEl.textContent = `🏃 Pique-pega · ${who} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  hudEl.hidden = false;
}
setInterval(updateHud, 500);

// ---- Títulos (guardados neste navegador) e cor do nome ----
const getTitles = () => { try { return JSON.parse(localStorage.getItem('titles') || '[]'); } catch { return []; } };
const equippedTitle = () => { try { const t = localStorage.getItem('title'); return t && getTitles().includes(t) ? t : null; } catch { return null; } };
function equipTitle(t) {
  try { t ? localStorage.setItem('title', t) : localStorage.removeItem('title'); } catch {}
  localInfo.title = t;
  refreshLabel(myId());
  connection.invoke('UpdateProfile', localInfo.nameColor, t).catch(() => {});
}
function onTitleEarned(t) {
  try { localStorage.setItem('titles', JSON.stringify([...new Set([...getTitles(), t])])); } catch {}
  addChatLine(null, `🏆 Você conquistou o título "${t}"! Ele já está equipado. Digite /titulo para ver todos.`);
  equipTitle(t);
}

// ---- Aviso sonoro quando um amigo entra ----
function playChime() {
  if (!music.ctx || !music.sfx || music.sfxMuted || music.ctx.state !== 'running') return;
  const t0 = music.ctx.currentTime;
  [[880, 0], [1318.5, 0.14]].forEach(([freq, delay]) => {
    const osc = music.ctx.createOscillator(), g = music.ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + delay);
    g.gain.linearRampToValueAtTime(0.2, t0 + delay + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.7);
    osc.connect(g); g.connect(music.sfx);
    osc.start(t0 + delay); osc.stop(t0 + delay + 0.75);
  });
}

// Plim discreto quando chega mensagem de um amigo no chat
let lastPing = 0;
// Reserva: o mesmo "ding-dong" como arquivo WAV gerado na hora e tocado por um <audio> comum. Serve quando o WebAudio
// está suspenso/bloqueado (alguns navegadores e celulares) mas o navegador já aceita tocar áudio depois do primeiro toque.
let pingWavUrl = null;
function pingWav() {
  if (pingWavUrl) return pingWavUrl;
  const rate = 22050, n = Math.floor(rate * 0.6), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate, second = t >= 0.12, tt = second ? t - 0.12 : t, f = second ? 1760 : 1318.5;
    const env = Math.min(1, tt / 0.01) * Math.exp(-tt * 7);
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * f * tt) * env * 0.8 * 32767), true);
  }
  return (pingWavUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
}

function playSend() {
  if (music.sfxMuted) return;
  unlockAudio();
  chip([1046.5, 1568], 0.045, 'square', 0.09); // dois "blips" 16 bits, mais discretos que o aviso de amigo
}

function playPing() {
  if (music.sfxMuted) return;
  unlockAudio(); // cria/retoma o áudio se o navegador o tiver suspendido
  const now = Date.now();
  if (now - lastPing < 150) return; // várias mensagens juntas não viram uma rajada de sons
  lastPing = now;
  if (music.ctx && music.sfx && music.ctx.state === 'running') {
    const t0 = music.ctx.currentTime;
    // "ding-dong" de duas notas, bem audível mesmo com a música tocando (ganho acima do aviso de entrada)
    [[1318.5, 0], [1760, 0.12]].forEach(([freq, delay]) => {
      for (const [type, mult, gain] of [['sine', 1, 0.9], ['triangle', 2, 0.2]]) {
        const osc = music.ctx.createOscillator(), g = music.ctx.createGain();
        osc.type = type; osc.frequency.value = freq * mult;
        g.gain.setValueAtTime(0.0001, t0 + delay);
        g.gain.linearRampToValueAtTime(gain, t0 + delay + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.45);
        osc.connect(g); g.connect(music.sfx);
        osc.start(t0 + delay); osc.stop(t0 + delay + 0.5);
      }
    });
    return;
  }
  // WebAudio parado: tenta o <audio> comum (e tenta acordar o WebAudio para as próximas vezes)
  console.info('[som] WebAudio não está ativo (' + (music.ctx ? music.ctx.state : 'sem contexto') + '); usando o aviso alternativo');
  music.ctx?.resume().catch(() => {});
  const a = new Audio(pingWav());
  a.volume = 0.7;
  a.play().catch(err => console.info('[som] o navegador bloqueou o aviso sonoro; clique na página uma vez', err?.name));
}

// ---- Comandos do chat: /comandos e a ajuda de cada um ----
const HELP = {
  emote: [
    '😀 Emotes: aperte as teclas 1 a 6 (👋 😂 ❤️ 👍 😮 😢) e o ícone aparece sobre a sua cabeça para todos.',
    'No celular, toque no botão 😀. Também funciona digitando /emote 3 (de 1 a 6).',
  ],
  cumprimentar: [
    '🤝 Cumprimentar: chegue perto de um amigo e aperte H (celular: botão 😀 e depois 🤝).',
    'O amigo também precisa apertar H em até 5 segundos. Cumprimentar 5 vezes dá o título "Cumprimentador".',
  ],
  empurrar: [
    '💢 Empurrar: fique bem ao lado de um amigo e aperte Q (celular: botão 😀 e depois 💢). Ele é jogado para longe.',
    'Use com carinho! Quem está nas costas de alguém não pode ser empurrado.',
  ],
  subir: [
    '🐴 Subir nas costas: chegue perto de um amigo e aperte R (celular: botão 😀 e depois 🐴). Você vai junto com ele.',
    'Dá para formar uma torre: outro amigo pode subir em você, e outro nele, até 10 jogadores empilhados!',
    'Para descer, aperte R de novo ou pule. Quem está carregando também pode apertar R para derrubar quem está nas costas.',
  ],
  danca: [
    '💃 Dança: aperte G para começar a dançar (celular: botão 😀 e depois 💃). Aperte G de novo ou ande para parar.',
    'Também dá para dançar em cima de um amigo, na torre!',
    'Quando vários amigos dançam juntos a dança fica sincronizada! Dançar por 90 segundos dá o título "Dançarino".',
  ],
  pique: [
    '🏃 Pique-pega: digite /pique iniciar para começar (mínimo de 2 jogadores, dura 90 segundos). /pique parar encerra.',
    'O pegador fica piscando todo em vermelho 🔴: encoste em alguém para passar a vez (quem foi pego tem 2 segundos de proteção).',
    'Vence quem ficar menos tempo como pegador e ganha o título "Campeão do Pique-Pega". Quem está nas costas de alguém não pode ser pego.',
  ],
  vilarejo: [
    '🏘️ Vilarejo: ande até a fonte, as barracas, a padaria, a ferraria ou a porta da esquerda.',
    'Quando aparecer o aviso no topo da tela, aperte E (celular: toque no aviso) para interagir. Todos veem o que você fez.',
  ],
  voz: [
    '🎧 Chat de voz: clique em 🎧 (no painel de online, no canto superior direito) para entrar e falar com os amigos em tempo real.',
    'Use 🎤 para mutar o microfone e 🎧 de novo para sair. Quem fala aparece com 🎙️ no nome, e o volume diminui com a distância.',
    'Também funciona com /voz entrar, /voz sair e /voz mutar. Precisa de um navegador com permissão de microfone.',
  ],
  compartilhar: [
    '📺 Compartilhar tela: digite /compartilhar, escolha a tela, janela ou aba e ela aparece numa projeção arcana sobre a sua cabeça para todos.',
    'Para parar, digite /compartilhar de novo (ou use o botão de parar do navegador). Para ouvir o som, marque "compartilhar áudio" ao escolher a aba.',
    'Clique na projeção de qualquer pessoa para ampliar (Esc fecha). Só funciona para compartilhar em computador; assistir funciona em qualquer aparelho.',
  ],
  titulo: null,
  cor: [
    '🎨 Cor do nome: digite /cor seguido de um código de cor, por exemplo /cor #ff8800. Você também escolhe na tela de entrada.',
  ],
};
const ALIASES = {
  ajuda: 'comandos', help: 'comandos', dancar: 'danca', costas: 'subir', montar: 'subir', carregar: 'subir',
  interagir: 'vilarejo', projecao: 'compartilhar', tela: 'compartilhar', cumprimento: 'cumprimentar', empurrao: 'empurrar', titulos: 'titulo',
};
const say = lines => lines.forEach(l => addChatLine(null, l));

// ---- Janela de ajuda (botão ? no canto inferior direito): grupos que expandem com as orientações ----
const HELP_GROUPS = [
  { title: '🤝 Ações sociais', keys: ['emote', 'cumprimentar', 'empurrar', 'subir', 'danca'] },
  { title: '🏃 Jogos e vilarejo', keys: ['pique', 'vilarejo'] },
  { title: '🎧 Voz e tela', keys: ['voz', 'compartilhar'] },
  { title: '🎨 Perfil', keys: ['titulo', 'cor'] },
];
const HELP_EXTRA = {
  titulo: [
    '🏷️ Títulos: digite /titulo para ver os que você conquistou, /titulo 1 para equipar o primeiro e /titulo nenhum para tirar.',
    'Conquiste jogando: vença o pique-pega, cumprimente 5 vezes ou dance por 90 segundos.',
  ],
};
const helpModal = document.getElementById('helpModal');
function setupHelp() {
  const box = document.getElementById('helpGroups');
  const intro = document.createElement('p');
  intro.textContent = '🎮 Andar: setas ← → · Pular: ↑ · Chat: Enter (comandos começam com /). Toque num grupo para ver como usar.';
  box.appendChild(intro);
  for (const g of HELP_GROUPS) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = g.title;
    const body = document.createElement('div');
    for (const k of g.keys) {
      const h = document.createElement('h4');
      h.textContent = '/' + k;
      body.appendChild(h);
      for (const line of HELP[k] || HELP_EXTRA[k] || []) {
        const p = document.createElement('p');
        p.textContent = line;
        body.appendChild(p);
      }
    }
    det.append(sum, body);
    box.appendChild(det);
  }
  helpBtn.hidden = false;
  fsBtnDesk.hidden = coarsePointer; // no celular o botão de tela cheia fica na coluna da esquerda
  helpBtn.addEventListener('click', () => { helpModal.hidden = !helpModal.hidden; });
  document.getElementById('helpClose').addEventListener('click', () => { helpModal.hidden = true; });
  helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.hidden = true; });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && !helpModal.hidden) helpModal.hidden = true; });
}

function runCommand(text) {
  const [raw, ...args] = text.slice(1).trim().split(/\s+/);
  let cmd = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  cmd = ALIASES[cmd] || cmd;

  if (cmd === 'comandos') {
    return say([
      '📜 Comandos (digite cada um para ver como usar):',
      '/emote — emotes sobre a cabeça',
      '/cumprimentar — toca aqui com um amigo',
      '/empurrar — empurrar um amigo',
      '/subir — subir nas costas de um amigo',
      '/danca — dançar (em grupo, fica sincronizado)',
      '/pique — jogo de pique-pega',
      '/vilarejo — interagir com a fonte, barracas e porta',
      '/titulo — ver e escolher seus títulos',
      '/cor — mudar a cor do seu nome',
      '/voz — chat de voz com microfone',
      '/compartilhar — compartilhar sua tela numa projeção sobre a sua cabeça',
      '/arena — como entrar na arena e lutar',
      '/floresta — como ir para a floresta',
      '/dash — dois toques na seta dão um impulso',
    ]);
  }
  if (cmd === 'emote' && /^[1-6]$/.test(args[0] || '')) return sendEmote(Number(args[0]) - 1);
  if (cmd === 'pique' && args[0]?.toLowerCase() === 'iniciar') return connection.invoke('StartTag');
  if (cmd === 'pique' && args[0]?.toLowerCase() === 'parar') return connection.invoke('StopTag');
  if (cmd === 'voz' && args[0]) {
    const a = args[0].toLowerCase();
    if (a === 'entrar') return joinVoice();
    if (a === 'sair') return leaveVoice();
    if (a === 'mutar') return toggleMute();
  }
  if (cmd === 'compartilhar') {
    if (args[0]?.toLowerCase() === 'ajuda') return say(HELP.compartilhar);
    return share.on ? stopShare() : startShare();
  }
  if (cmd === 'titulo') return titleCommand(args);
  if (cmd === 'cor' && args[0]) return colorCommand(args[0]);
  if (HELP[cmd]) return say(HELP[cmd]);
  say([`Comando desconhecido: /${raw}. Digite /comandos para ver a lista.`]);
}

function titleCommand(args) {
  const titles = getTitles();
  if (!args.length) {
    if (!titles.length) {
      return say(['🏷️ Você ainda não tem títulos.', 'Conquiste jogando: vença o pique-pega, cumprimente 5 vezes ou dance por 90 segundos.']);
    }
    return say(['🏷️ Seus títulos:', ...titles.map((t, i) => `${i + 1}) ${t}${t === localInfo.title ? ' (equipado)' : ''}`),
      'Use /titulo 1 para equipar o primeiro, ou /titulo nenhum para tirar.']);
  }
  if (args[0].toLowerCase() === 'nenhum') { equipTitle(null); return say(['Título removido.']); }
  const t = titles[Number(args[0]) - 1];
  if (!t) return say(['Título não encontrado. Digite /titulo para ver a lista.']);
  equipTitle(t);
  say([`🏷️ Título "${t}" equipado!`]);
}

function colorCommand(arg) {
  const hex = (arg.startsWith('#') ? arg : '#' + arg).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return say(['Cor inválida. Use um código como /cor #ff8800 (6 dígitos, de 0 a 9 e a a f).']);
  localInfo.nameColor = hex;
  cName.value = hex;
  saveProfile();
  refreshLabel(myId());
  connection.invoke('UpdateProfile', hex, localInfo.title).catch(() => {});
  say(['🎨 Cor do nome alterada!']);
}

// ---- Atalhos de teclado (PC) e botões na bandeja (celular) ----
const KEY_ACTIONS = { h: doGreet, q: doPush, r: doRide, g: doDance, e: doInteract };
window.addEventListener('keydown', e => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !chatReady || !chatBar.hidden || !helpModal.hidden || currentMap === 'arena') return;
  KEY_ACTIONS[e.key.toLowerCase()]?.();
});
[['🤝', 'Cumprimentar', doGreet], ['💢', 'Empurrar', doPush], ['🐴', 'Subir ou descer das costas', doRide],
 ['💃', 'Dançar', doDance], ['✋', 'Interagir', doInteract]].forEach(([icon, title, fn]) => {
  const b = document.createElement('button');
  b.textContent = icon; b.title = title;
  b.addEventListener('click', () => { fn(); emoteTray.classList.remove('open'); });
  emoteTray.appendChild(b);
});

// ======================= Chat de voz (WebRTC, em malha) =======================
// Cada pessoa na voz abre uma conexão de áudio direta com cada uma das outras.
// O servidor só ajuda a "apresentar" os navegadores (mensagens offer/answer/ICE via SignalR).
const VOICE_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  // Redes que bloqueiam a conexão direta (ex.: dados móveis) precisam de um servidor TURN. Se algum amigo
  // não conseguir ouvir/falar, o servidor entrega também um TURN em /ice-servers (veja abaixo).
];
// Lista de servidores ICE vinda do servidor (STUN + TURN). Se o servidor for antigo ou não responder em 3 s, usa só o STUN.
let ICE_SERVERS = VOICE_ICE_SERVERS;
const iceReady = (async () => {
  try {
    const r = await fetch(SERVER_URL + '/ice-servers', { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    const list = r.ok ? await r.json() : null;
    if (Array.isArray(list) && list.length) ICE_SERVERS = list;
  } catch { /* fica com o STUN */ }
})();
const VOICE_NEAR = 450, VOICE_FAR = 1300, VOICE_MIN_VOLUME = 0.35; // volume por distância no mapa
const SPEAKING_LEVEL = 0.02; // sensibilidade para mostrar 🎙️

const voice = { on: false, muted: false, stream: null, ctx: null, peers: {}, members: new Set(), levels: {} };
const voiceBtn = document.getElementById('voiceBtn');
const micBtn = document.getElementById('micBtn');

function updateVoiceButtons() {
  voiceBtn.textContent = voice.on ? '🎧✔' : '🎧';
  micBtn.hidden = !voice.on;
  micBtn.textContent = voice.muted ? '🎤✖' : '🎤';
  renderOnline();
}

const sendSignal = (id, obj) => connection.invoke('VoiceSignal', id, JSON.stringify(obj)).catch(() => {});

function createPeer(id) {
  if (voice.peers[id]) return voice.peers[id];
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // queue: os sinais de cada par são tratados um de cada vez (offer/answer/ICE chegam em sequência, mas o processamento é assíncrono)
  const peer = { pc, audio: null, pending: [], queue: Promise.resolve(), initiator: false, restarts: 0 };
  voice.peers[id] = peer;
  voice.stream.getTracks().forEach(t => pc.addTrack(t, voice.stream));
  peer.cands = { host: 0, srflx: 0, relay: 0 };
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    peer.cands[e.candidate.type] = (peer.cands[e.candidate.type] || 0) + 1;
    sendSignal(id, { candidate: e.candidate });
  };
  pc.ontrack = e => {
    if (peer.audio) return;
    const audio = document.createElement('audio');
    audio.autoplay = true; audio.playsInline = true;
    audio.srcObject = e.streams[0];
    document.body.appendChild(audio);
    audio.play().catch(() => {});
    peer.audio = audio;
    watchLevel(id, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    console.info(`[voz] ${remotePlayers[id]?.name || id}: ${pc.connectionState}`); // ajuda a descobrir qual par não conecta
    if (voice.peers[id] !== peer) return;
    if (pc.connectionState === 'connected') { peer.restarts = 0; peer.audio?.play().catch(() => {}); }
    if (pc.connectionState === 'disconnected') setTimeout(() => { if (voice.peers[id] === peer && pc.connectionState === 'disconnected') restartPeer(id); }, 4000);
    if (pc.connectionState === 'failed') {
      if (peer.restarts < 2 && restartPeer(id)) return; // quem ligou tenta de novo (reinício do ICE) antes de desistir
      if (peer.initiator || peer.restarts >= 2) {
        const name = remotePlayers[id]?.name || 'um amigo';
        say([`⚠️ Não consegui conectar a voz com ${name}. A rede dessa pessoa pode estar bloqueando conexões diretas (é comum em dados móveis).`]);
        closePeer(id);
      }
    }
  };
  // sem conexão em 12 s: avisa no chat (e mostra no console quais tipos de candidato existiram: host/srflx/relay)
  setTimeout(() => {
    if (voice.peers[id] !== peer || pc.connectionState === 'connected') return;
    console.warn(`[voz] sem conexão com ${remotePlayers[id]?.name || id} após 12 s. Candidatos locais:`, peer.cands, 'ICE:', pc.iceConnectionState);
    say([`⚠️ Ainda sem voz com ${remotePlayers[id]?.name || 'um amigo'}. A rede de alguém pode estar bloqueando conexões diretas.`]);
  }, 12000);
  // se o par não conectar em 15 s (sinal perdido), recomeça a ligação uma vez
  setTimeout(() => {
    if (voice.peers[id] === peer && pc.connectionState !== 'connected' && peer.restarts < 1) restartPeer(id);
  }, 15000);
  return peer;
}

// Só quem ligou originalmente reinicia a conexão (evita os dois oferecerem ao mesmo tempo)
function restartPeer(id) {
  const peer = voice.peers[id];
  if (!peer || !peer.initiator || !voice.on || peer.pc.signalingState !== 'stable') return false;
  peer.restarts++;
  peer.queue = peer.queue.then(async () => {
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
    sendSignal(id, { sdp: peer.pc.localDescription });
  }).catch(() => {});
  return true;
}

function closePeer(id) {
  const peer = voice.peers[id];
  if (peer) { peer.pc.close(); peer.audio?.remove(); delete voice.peers[id]; }
  stopWatching(id);
}

async function callPeer(id) { // quem acabou de entrar na voz inicia a conexão
  const peer = createPeer(id);
  peer.initiator = true;
  const { pc } = peer;
  await pc.setLocalDescription(await pc.createOffer());
  sendSignal(id, { sdp: pc.localDescription });
}

function handleVoiceSignal(from, payload) {
  if (!voice.on) return;
  let msg;
  try { msg = JSON.parse(payload); } catch { return; }
  const peer = createPeer(from);
  peer.queue = peer.queue.then(() => processVoiceSignal(from, peer, msg)).catch(() => { /* mensagem inválida ou fora de ordem: ignora */ });
}

async function processVoiceSignal(from, peer, msg) {
  const { pc } = peer;
  if (msg.sdp) {
    // ofertas cruzadas (os dois ligaram ao mesmo tempo): o de menor id mantém a sua oferta; o outro desiste da dele e atende
    if (msg.sdp.type === 'offer' && pc.signalingState !== 'stable') {
      if (myId() < from) return;
      await pc.setLocalDescription({ type: 'rollback' });
      peer.initiator = false;
    }
    await pc.setRemoteDescription(msg.sdp);
    for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (msg.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal(from, { sdp: pc.localDescription });
    }
  } else if (msg.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
    else peer.pending.push(msg.candidate); // chegou antes da oferta/resposta: guarda
  }
}

// ---- Quem está falando (🎙️) e volume por distância ----
function watchLevel(id, stream) {
  try {
    const an = voice.ctx.createAnalyser();
    an.fftSize = 512;
    voice.ctx.createMediaStreamSource(stream).connect(an); // só mede; não toca de novo
    voice.levels[id] = { an, data: new Uint8Array(an.fftSize) };
  } catch {}
}
function stopWatching(id) {
  delete voice.levels[id];
  const info = id === myId() ? localInfo : remotePlayers[id];
  if (info?.speaking) { info.speaking = false; refreshLabel(id); }
}
setInterval(() => {
  for (const [id, lv] of Object.entries(voice.levels)) {
    lv.an.getByteTimeDomainData(lv.data);
    let sum = 0;
    for (const v of lv.data) sum += ((v - 128) / 128) ** 2;
    const speaking = Math.sqrt(sum / lv.data.length) > SPEAKING_LEVEL && !(id === myId() && voice.muted);
    const info = id === myId() ? localInfo : remotePlayers[id];
    if (info && info.speaking !== speaking) { info.speaking = speaking; refreshLabel(id); }
  }
  for (const [id, peer] of Object.entries(voice.peers)) { // quanto mais longe no mapa, mais baixo
    const r = remotePlayers[id]?.rect;
    if (!peer.audio || !r || typeof player === 'undefined') continue;
    if (remotePlayers[id].map !== currentMap) { peer.audio.volume = VOICE_MIN_VOLUME; continue; }
    const d = Math.hypot(r.x - player.x, r.y - player.y);
    peer.audio.volume = Math.max(VOICE_MIN_VOLUME, Math.min(1, 1 - (d - VOICE_NEAR) / (VOICE_FAR - VOICE_NEAR) * (1 - VOICE_MIN_VOLUME)));
  }
}, 120);

// ---- Entrar, sair e mutar ----
async function joinVoice() {
  if (voice.on) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    return say(['Seu navegador não suporta chat de voz.']);
  }
  await iceReady; // servidores STUN/TURN (no máx. 3 s)
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
  } catch {
    return say(['🎤 Não consegui acessar o microfone. Permita o acesso no navegador (ícone ao lado do endereço) e tente de novo.']);
  }
  voice.on = true;
  voice.muted = false;
  voice.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  voice.ctx.resume();
  watchLevel(myId(), voice.stream);
  updateVoiceButtons();
  say(['🎧 Você entrou no chat de voz. Use 🎤 para mutar e 🎧 para sair.']);
  connection.invoke('JoinVoice');
}

function leaveVoice() {
  if (!voice.on) return;
  connection.invoke('LeaveVoice').catch(() => {});
  Object.keys(voice.peers).forEach(closePeer);
  voice.stream?.getTracks().forEach(t => t.stop());
  stopWatching(myId());
  voice.on = false; voice.stream = null;
  updateVoiceButtons();
  say(['🎧 Você saiu do chat de voz.']);
}

function toggleMute() {
  if (!voice.on) return say(['Entre no chat de voz primeiro (botão 🎧).']);
  voice.muted = !voice.muted;
  voice.stream.getAudioTracks().forEach(t => { t.enabled = !voice.muted; });
  updateVoiceButtons();
}

function setupVoiceEvents() {
  connection.on('VoiceMembers', ids => { voice.members = new Set(ids); renderOnline(); });
  connection.on('VoiceRoster', ids => { ids.forEach(id => { voice.members.add(id); callPeer(id).catch(() => closePeer(id)); }); });
  connection.on('VoiceState', (id, on) => {
    if (on) voice.members.add(id); else { voice.members.delete(id); closePeer(id); }
    renderOnline();
  });
  connection.on('VoiceSignal', handleVoiceSignal);
}

voiceBtn.addEventListener('click', () => (voice.on ? leaveVoice() : joinVoice()));
micBtn.addEventListener('click', toggleMute);

// ======================= Projeção: compartilhar a tela (WebRTC) =======================
// Quem compartilha mostra o vídeo numa moldura sobre a cabeça. Cada espectador liga para quem compartilha
// (vídeo só de ida), então só quem assiste consome a internet de quem compartilha. Os servidores STUN são os da voz.
let projMeta = null;
const projReady = fetch('assets/projecao.json').then(r => r.json()).then(m => { projMeta = m; });
const PROJ_W = 130; // largura da projeção no mundo (px)
const PROJ_BOTTOM_DY = CHAR_H / 2 + 46; // a moldura fica logo acima do nome (e do título)
// quem está compartilhando tem o balão de fala acima da projeção, para não ficar escondido atrás dela
const shareLift = id => ((id === myId() ? share.on : share.sharers.has(id)) && projMeta ? PROJ_W * projMeta.height / projMeta.width + 8 : 0);
const SHARE_MAX_BITRATE = 800_000;

const SHARE_RANGE = 170; // distância (no mundo) para interagir com a projeção e começar a assistir
const SHARE_STOP = 720;  // se você se afastar além disto, a transmissão para de chegar até você (economiza internet de quem compartilha)
// sharers: quem está compartilhando; viewers: conexões de quem me assiste; views: as minhas, de quem eu assisto
const share = { on: false, stream: null, sharers: new Set(), viewers: {}, views: {} };
const projections = {}; // id -> { root, video }
let theaterId = null;

function ensureProjection(id) {
  if (projections[id]) return projections[id];
  const m = projMeta;
  const root = document.createElement('div');
  root.className = 'proj';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = id === myId();
  // o vídeo só aparece dentro da abertura oval da moldura (um pouco maior; o anel cobre a borda)
  video.style.clipPath = `ellipse(${(m.rx * 100 + 1.5).toFixed(1)}% ${(m.ry * 100 + 1.5).toFixed(1)}% at ${m.cx * 100}% ${m.cy * 100}%)`;
  // aviso dentro da abertura enquanto ninguém está assistindo (quem compartilha vê a própria tela direto)
  const idle = document.createElement('div');
  idle.className = 'idle';
  idle.style.clipPath = video.style.clipPath;
  idle.textContent = id === myId() ? '' : (coarsePointer ? '▶ Chegue perto e toque' : '▶ Chegue perto e aperte E');
  const ring = new Image();
  ring.className = 'ring'; ring.src = 'assets/projecao.png'; ring.draggable = false;
  root.append(video, idle, ring);
  root.addEventListener('click', () => onProjectionClick(id));
  document.getElementById('sprites').appendChild(root);
  return (projections[id] = { root, video, idle });
}

function removeProjection(id) {
  projections[id]?.root.remove();
  delete projections[id];
  if (theaterId === id) closeTheater();
}

function updateProjections() {
  if (!projMeta) return;
  const r = phaserGame.canvas.getBoundingClientRect(), k = r.width / WORLD_W;
  const h = PROJ_W * projMeta.height / projMeta.width;
  for (const [id, p] of Object.entries(projections)) {
    const sprite = id === myId() ? localSprite : remotePlayers[id]?.rect;
    p.root.style.display = sprite && sprite.visible ? '' : 'none';
    if (!sprite || !sprite.visible) continue;
    p.root.style.setProperty('--k', k);
    p.root.style.width = PROJ_W * k + 'px';
    p.root.style.height = h * k + 'px';
    p.root.style.transform = `translate(${r.left + (sprite.x - PROJ_W / 2) * k}px, ${r.top + (sprite.y - PROJ_BOTTOM_DY - h - liftFor(id)) * k}px)`;
  }
}

// o som da transmissão diminui com a distância, como a voz; ficar longe demais encerra a visualização
setInterval(() => {
  for (const [id, p] of Object.entries(projections)) {
    const r = remotePlayers[id]?.rect;
    if (!r || id === myId() || typeof player === 'undefined') continue;
    const d = Math.hypot(r.x - player.x, r.y - player.y);
    if (share.views[id] && d > SHARE_STOP) { stopWatching(id); continue; }
    if (theaterId === id) continue;
    p.video.volume = Math.max(VOICE_MIN_VOLUME, Math.min(1, 1 - (d - VOICE_NEAR) / (VOICE_FAR - VOICE_NEAR) * (1 - VOICE_MIN_VOLUME)));
  }
}, 200);

// ---- Tela ampliada (clique na projeção) ----
const theater = document.getElementById('theater');
const theaterVideo = theater.querySelector('video');
function openTheater(id) {
  const p = projections[id];
  if (!p || !p.video.srcObject) return;
  theaterId = id;
  theaterVideo.srcObject = p.video.srcObject;
  theaterVideo.muted = id === myId();
  theaterVideo.play().catch(() => {});
  p.video.muted = true; // o som sai só pela tela ampliada
  const name = id === myId() ? 'Você' : remotePlayers[id]?.name || 'Alguém';
  document.getElementById('theaterCaption').textContent = `📺 ${name} — clique ou aperte Esc para fechar`;
  theater.hidden = false;
}
function closeTheater() {
  theater.hidden = true;
  theaterVideo.srcObject = null;
  const p = projections[theaterId];
  if (p) p.video.muted = theaterId === myId();
  theaterId = null;
}
theater.addEventListener('click', closeTheater);
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !theater.hidden) closeTheater(); });

// ---- Quem compartilha ----
const sendShareSignal = (id, obj) => connection.invoke('ShareSignal', id, JSON.stringify(obj)).catch(() => {});

async function startShare() {
  if (share.on) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return say(['Este navegador/aparelho não permite compartilhar a tela. Use o computador (Chrome, Edge ou Firefox).']);
  }
  try {
    share.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 20 }, width: { max: 1280 }, height: { max: 720 } }, // miniatura leve
      audio: true,
    });
  } catch { return say(['Compartilhamento cancelado.']); }

  const vt = share.stream.getVideoTracks()[0];
  if (vt) { vt.contentHint = 'detail'; vt.addEventListener('ended', stopShare); } // botão "parar" do navegador
  await projReady;
  share.on = true;
  const p = ensureProjection(myId());
  p.video.srcObject = share.stream;
  p.idle.style.display = 'none';
  connection.invoke('StartShare');
  say(['📺 Você está compartilhando a tela. Para parar, digite /compartilhar de novo. Clique na projeção para ampliar.']);
}

function stopShare() {
  if (!share.on) return;
  share.on = false;
  connection.invoke('StopShare').catch(() => {});
  Object.values(share.viewers).forEach(v => v.pc.close());
  share.viewers = {};
  share.stream.getTracks().forEach(t => t.stop());
  share.stream = null;
  removeProjection(myId());
  say(['📺 Você parou de compartilhar a tela.']);
}

async function handleShareSignal(from, payload) {
  let msg;
  try { msg = JSON.parse(payload); } catch { return; }
  try {
    if (share.on && (msg.sdp?.type === 'offer' || share.viewers[from])) return await answerViewer(from, msg);
    const view = share.views[from];
    if (!view) return;
    if (msg.sdp) {
      await view.pc.setRemoteDescription(msg.sdp);
      for (const c of view.pending.splice(0)) await view.pc.addIceCandidate(c).catch(() => {});
    } else if (msg.candidate) {
      if (view.pc.remoteDescription) await view.pc.addIceCandidate(msg.candidate).catch(() => {});
      else view.pending.push(msg.candidate);
    }
  } catch { /* mensagem inválida ou fora de ordem */ }
}

// Quem compartilha atende a oferta de cada espectador e envia a tela (limitando a qualidade)
async function answerViewer(from, msg) {
  let v = share.viewers[from];
  if (!v) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    v = share.viewers[from] = { pc, pending: [] };
    pc.onicecandidate = e => { if (e.candidate) sendShareSignal(from, { candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && share.viewers[from] === v) { pc.close(); delete share.viewers[from]; }
    };
  }
  const { pc } = v;
  if (msg.sdp) {
    await pc.setRemoteDescription(msg.sdp);
    for (const c of v.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (msg.sdp.type === 'offer') {
      share.stream.getTracks().forEach(t => pc.addTrack(t, share.stream));
      await pc.setLocalDescription(await pc.createAnswer());
      sendShareSignal(from, { sdp: pc.localDescription });
      pc.getSenders().filter(s => s.track?.kind === 'video').forEach(async sender => {
        try {
          const params = sender.getParameters();
          params.encodings = params.encodings?.length ? params.encodings : [{}];
          params.encodings[0].maxBitrate = SHARE_MAX_BITRATE;
          await sender.setParameters(params);
        } catch {}
      });
    }
  } else if (msg.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(() => {});
    else v.pending.push(msg.candidate);
  }
}

// ---- Quem assiste ----
async function startWatching(id) {
  if (share.views[id] || id === myId()) return;
  await projReady;
  await iceReady;
  if (share.views[id]) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const view = share.views[id] = { pc, pending: [] };
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const proj = ensureProjection(id);
  pc.onicecandidate = e => { if (e.candidate) sendShareSignal(id, { candidate: e.candidate }); };
  pc.ontrack = e => {
    proj.video.srcObject = e.streams[0] || new MediaStream([e.track]);
    playProjection(proj.video);
    proj.idle.style.display = 'none';
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && share.views[id] === view) {
      say([`⚠️ Não consegui receber a tela de ${remotePlayers[id]?.name || 'um amigo'}. A rede pode estar bloqueando conexões diretas (é comum em dados móveis).`]);
      stopWatching(id);
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  sendShareSignal(id, { sdp: pc.localDescription });
}

// Alguns navegadores bloqueiam vídeo com som sem um toque recente: nesse caso começa sem som (o som vem ao ampliar)
function playProjection(video) {
  video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
}

// Para de assistir (a projeção continua lá, esperando alguém interagir de novo)
function stopWatching(id) {
  share.views[id]?.pc.close();
  delete share.views[id];
  const p = projections[id];
  if (p && id !== myId()) { p.video.srcObject = null; p.idle.style.display = ''; }
  if (theaterId === id) closeTheater();
  lastHintKey = null; // reavalia o aviso de interação
}

// Encerra tudo com um jogador (parou de compartilhar ou saiu)
function dropShare(id) {
  share.sharers.delete(id);
  stopWatching(id);
  if (share.viewers[id]) { share.viewers[id].pc.close(); delete share.viewers[id]; }
  if (id !== myId()) removeProjection(id);
}

// Alguém começou a compartilhar: a projeção aparece sobre a cabeça, mas só assiste quem chegar perto e interagir
function markSharer(id) {
  if (id === myId()) return;
  share.sharers.add(id);
  projReady.then(() => { if (share.sharers.has(id)) ensureProjection(id); });
}

function nearestSharer() {
  let best = null, bestDx = SHARE_RANGE;
  for (const id of share.sharers) {
    const r = remotePlayers[id]?.rect;
    if (!r || remotePlayers[id].map !== currentMap) continue;
    const dx = Math.abs(r.x - player.x);
    if (dx < bestDx && Math.abs(r.y - player.y) < 130) { best = id; bestDx = dx; }
  }
  return best;
}

// E (ou toque) perto da projeção: começa a assistir; se já está assistindo, amplia
function interactShare(id) {
  if (share.views[id]) return openTheater(id);
  say([`📺 Conectando à transmissão de ${remotePlayers[id]?.name || 'um amigo'}... Interaja de novo para ampliar. Se afastar muito, a transmissão para.`]);
  startWatching(id);
}

function onProjectionClick(id) {
  if (id === myId()) return openTheater(id);
  const r = remotePlayers[id]?.rect;
  if (!r || Math.abs(r.x - player.x) > SHARE_RANGE * 1.4 || Math.abs(r.y - player.y) > 160) {
    return say(['Chegue mais perto da projeção para assistir.']);
  }
  interactShare(id);
}

function setupShareEvents() {
  connection.on('ShareState', (id, on) => { if (on) markSharer(id); else dropShare(id); });
  connection.on('ShareSignal', handleShareSignal);
}

// ======================= Mapas, arena (combate) e dash =======================
// Vilarejo e arena são mapas separados: andar até o fim da rua à direita leva à arena (e o fim da esquerda da arena volta).
// O servidor (ArenaGame.cs) decide vida, dano, alcance e pontos; aqui ficam os controles, o HUD e os efeitos visuais.
const WEAPONS = [
  { name: 'Espada', icon: '⚔️' }, { name: 'Lança', icon: '🔱' }, { name: 'Arco', icon: '🏹' },
  { name: 'Martelo', icon: '🔨' }, { name: 'Garras', icon: '🐾' },
];
const MAP_EDGE_ZONE = 56; // faixa junto da borda onde segurar a seta (ou dar um dash) troca de mapa
const MAP_EDGE_HOLD_MS = 400, ATTACK_MIN_GAP_MS = 120, ARROW_SPEED = 600, ARROW_RANGE = 650;
const DASH_SPEED = 600, DASH_MS = 140, DASH_COOLDOWN_MS = 500, DASH_TAP_MS = 250;

let signArena = null, signForest = null, facing = 1, myWeapon = 0, edgeHold = 0, mapRequestAt = 0, lastAttackAt = 0;
let dashUntil = 0, dashDir = 1, dashReadyAt = 0, prevLeft = false, prevRight = false;
const lastTap = { left: -1e9, right: -1e9 };
let arenaList = [], arenaById = {};
const arrows = {};
let barsGfx = null;

const arenaRankEl = document.getElementById('arenaRank');
const arenaRankList = document.getElementById('arenaRankList');
const arenaBarEl = document.getElementById('arenaBar');
const arenaHpFill = document.getElementById('arenaHpFill');
const arenaHpText = document.getElementById('arenaHpText');
const arenaMsgEl = document.getElementById('arenaMsg');
const weaponsEl = document.getElementById('arenaWeapons');

const spritePos = id => { const sp = id === myId() ? localSprite : remotePlayers[id]?.rect; return sp ? { x: sp.x, y: sp.y } : null; };
const isHere = id => id === myId() || remotePlayers[id]?.map === currentMap;
const arenaMeAlive = () => arenaById[myId()]?.alive !== false;

// quem está em outro mapa não aparece (corpo, nome, GIF e balão)
// Coloca na mão de cada boneco a arma escolhida (só nos mapas de combate)
function updateHeldWeapons() {
  const set = (id, sprite) => {
    if (!sprite || !sprite.setWeapon) return; // só bonecos têm braço (imagens e GIFs não)
    const st = arenaById[id];
    const kind = isCombat() && isHere(id) && st && st.map === currentMap ? (id === myId() ? myWeapon : st.weapon) : null;
    sprite.setWeapon(kind);
  };
  set(myId(), localSprite);
  for (const id in remotePlayers) set(id, remotePlayers[id].rect);
}

function syncVisibility(id) {
  const r = remotePlayers[id];
  if (!r) return;
  const here = r.map === currentMap;
  if (r.rect.visible !== here) { r.rect.setVisible(here); r.label.setVisible(here); }
}

function hideInteractHint() {
  if (interactHint.hidden && lastHintKey === null) return;
  interactHint.hidden = true; lastHintKey = null; currentSpot = -1; currentShareTarget = null;
}

// ---- Troca de mapa ----
function applyMap(map) {
  currentMap = map;
  const arena = map === 'arena';
  document.body.classList.toggle('inArena', arena || map === 'forest'); // (a classe também mostra o botão de ataque na floresta)
  signArena?.setVisible(map === 'village');
  signForest?.setVisible(map === 'village');
  if (arena) background.setTexture('fundo_arena').setDisplaySize(WORLD_W, VIEW_H);
  else if (map === 'forest') background.setTexture('fundo_floresta').setDisplaySize(WORLD_W, VIEW_H);
  else setVillageBackground();
  for (const id in remotePlayers) syncVisibility(id);
  for (const id in bubbles) { bubbles[id].text.destroy(); delete bubbles[id]; }
  helpModal.hidden = true;
  refreshHelpForMap();
  updateArenaHud();
  hideMoveHint();
  gameScene.cameras.main.fadeIn(300, 0, 0, 0);
  renderOnline();
}

function setVillageBackground() {
  backgroundPeriod = backgroundForHour(new Date().getHours());
  const period = backgroundPeriod, key = 'bg' + period;
  const apply = () => { if (currentMap === 'village' && backgroundPeriod === period) background.setTexture(key).setDisplaySize(WORLD_W, VIEW_H); };
  if (gameScene.textures.exists(key)) apply();
  else { gameScene.load.image(key, BACKGROUNDS[period]); gameScene.load.once('complete', apply); gameScene.load.start(); }
}

// Mapas ligados pelas bordas: floresta ←(esquerda) vilarejo (direita)→ arena. Segurar a seta junto da borda (ou dar um dash
// contra ela) por um instante pede a troca de mapa ao servidor.
function edgeTarget(left, right) {
  const nearL = player.x <= MAP_EDGE_ZONE, nearR = player.x >= WORLD_W - MAP_EDGE_ZONE;
  if (currentMap === 'village') return left && nearL ? 'forest' : right && nearR ? 'arena' : null;
  if (currentMap === 'forest') return right && nearR ? 'village' : null;
  return left && nearL ? 'village' : null; // arena
}
function checkMapEdge(delta, left, right, carrier, dashing = false) {
  const target = carrier ? null : edgeTarget(left, right);
  edgeHold = target ? (dashing ? MAP_EDGE_HOLD_MS : edgeHold + delta) : 0;
  if (!target || edgeHold < MAP_EDGE_HOLD_MS || Date.now() - mapRequestAt < 1200) return;
  mapRequestAt = Date.now();
  edgeHold = 0;
  connection.invoke('ChangeMap', target).catch(() => {
    say(['⚠️ Esse mapa ainda não está disponível no servidor (ele pode estar atualizando). Tente de novo em alguns minutos.']);
  });
}

// ---- Dash: dois toques rápidos para o lado (no chão ou no ar) ----
function handleDash(time, left, right) {
  const tapL = left && !prevLeft, tapR = right && !prevRight;
  prevLeft = left; prevRight = right;
  for (const [tap, key, dir] of [[tapL, 'left', -1], [tapR, 'right', 1]]) {
    if (!tap) continue;
    if (time - lastTap[key] <= DASH_TAP_MS && time >= dashReadyAt && time >= pushUntil && !ridingMap[myId()]) {
      dashUntil = time + DASH_MS; dashDir = dir; dashReadyAt = time + DASH_COOLDOWN_MS;
      lastTap[key] = -1e9;
      if (localDancing) setDancing(false);
      dashFx(myId(), dir);
      sfxDash();
      connection.invoke('Dash', dir).catch(() => {});
    } else lastTap[key] = time;
  }
}

function dashFx(id, dir) {
  const p = spritePos(id);
  if (!p || !isHere(id)) return;
  const g = gameScene.add.graphics().setDepth(6).setPosition(p.x - dir * 18, p.y);
  g.lineStyle(3, 0xffffff, 0.8);
  for (const dy of [-18, -2, 14]) g.lineBetween(0, dy, -dir * (28 + Math.abs(dy)), dy);
  gameScene.tweens.add({ targets: g, alpha: 0, x: g.x - dir * 22, duration: 240, onComplete: () => g.destroy() });
  if (p.y > GROUND_TOP - 50) { // poeira nos pés
    for (let i = 0; i < 5; i++) {
      const c = gameScene.add.circle(p.x - dir * (6 + i * 7), GROUND_TOP - 3, 3 + Math.random() * 2, 0xd8cdb8, 0.8).setDepth(6);
      gameScene.tweens.add({ targets: c, y: c.y - 10 - Math.random() * 8, scale: 2, alpha: 0, duration: 320, onComplete: () => c.destroy() });
    }
  }
}

// Sons estilo 16 bits: notas em degraus (ondas quadrada/serra/triângulo) e rajadas de ruído, como nos consoles antigos
function chip(notes, step, type = 'square', gain = 0.1) {
  if (!music.ctx || !music.sfx || music.sfxMuted || music.ctx.state !== 'running') return;
  const t0 = music.ctx.currentTime, o = music.ctx.createOscillator(), g = music.ctx.createGain();
  o.type = type;
  notes.forEach((f, i) => o.frequency.setValueAtTime(f || 1, t0 + i * step)); // sem rampa: a frequência "pula" de nota em nota
  const end = t0 + notes.length * step;
  g.gain.setValueAtTime(gain, t0);
  g.gain.setValueAtTime(gain * 0.7, t0 + notes.length * step * 0.6);
  g.gain.linearRampToValueAtTime(0.0001, end);
  o.connect(g); g.connect(music.sfx); o.start(t0); o.stop(end + 0.02);
}
let noiseBuf = null;
function chipNoise(dur, gain = 0.12, filter = 'highpass', cutoff = 2000, delay = 0) {
  if (!music.ctx || !music.sfx || music.sfxMuted || music.ctx.state !== 'running') return;
  const ctx = music.ctx;
  if (!noiseBuf) { // ruído "áspero": valores sorteados e mantidos por 2 amostras (parece de chip de som)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i += 2) d[i] = d[i + 1] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + delay, src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noiseBuf; flt.type = filter; flt.frequency.value = cutoff;
  g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(flt); flt.connect(g); g.connect(music.sfx); src.start(t0); src.stop(t0 + dur + 0.02);
}
function sfxAttack(weapon) {
  if (weapon === 0) { chipNoise(0.1, 0.1, 'highpass', 2500); chip([880, 1175, 1568, 1760], 0.025, 'square', 0.07); } // espada: "shing"
  else if (weapon === 1) { chipNoise(0.08, 0.08, 'bandpass', 3000); chip([660, 880, 1320, 1760, 1976], 0.022, 'square', 0.07); } // lança: estocada
  else if (weapon === 2) { chip([1400, 1100, 800, 560, 420], 0.028, 'triangle', 0.14); chipNoise(0.05, 0.06, 'highpass', 4000, 0.02); } // arco: "tuim"
  else if (weapon === 3) { chipNoise(0.22, 0.2, 'lowpass', 700, 0.04); chip([196, 147, 110, 82, 65], 0.05, 'square', 0.14); } // martelo: pancada grave
  else { chip([1568, 1319, 1568, 1319, 1760], 0.02, 'sawtooth', 0.06); chipNoise(0.07, 0.09, 'highpass', 3500); } // garras: riscos rápidos
}
function sfxHurt(me) {
  if (me) { chip([392, 311, 247, 196, 147], 0.045, 'square', 0.16); chipNoise(0.14, 0.14, 'lowpass', 1800); } // você apanhou: mais forte
  else { chip([294, 220, 165], 0.04, 'square', 0.07); chipNoise(0.08, 0.07, 'lowpass', 2200); }
}
function sfxDeath() { chip([440, 415, 392, 349, 311, 277, 233, 196, 147, 110], 0.065, 'square', 0.13); chipNoise(0.35, 0.12, 'lowpass', 900, 0.4); }
function sfxDash() { chipNoise(0.14, 0.08, 'bandpass', 1500); chip([300, 450, 600], 0.03, 'square', 0.04); }

// ---- Ataque e armas ----
function doAttack() {
  if (!isCombat() || !chatReady || !arenaMeAlive() || ridingMap[myId()]) return;
  const now = Date.now();
  if (now - lastAttackAt < ATTACK_MIN_GAP_MS) return;
  lastAttackAt = now;
  connection.invoke('Attack', facing).catch(() => {});
}

function selectWeapon(i) {
  if (i < 0 || i >= WEAPONS.length) return;
  myWeapon = i;
  updateArenaHud();
  connection.invoke('SetWeapon', i).catch(() => {});
}

WEAPONS.forEach((w, i) => {
  const b = document.createElement('button');
  b.title = `${w.name} (tecla ${i + 1})`;
  const k = document.createElement('small'); k.textContent = i + 1;
  b.append(k, document.createTextNode(w.icon));
  b.addEventListener('click', () => selectWeapon(i));
  weaponsEl.appendChild(b);
});
document.getElementById('attackBtn').addEventListener('pointerdown', e => { e.preventDefault(); doAttack(); });
window.addEventListener('keydown', e => {
  if (!isCombat() || e.ctrlKey || e.metaKey || e.altKey || !chatReady || !chatBar.hidden || !helpModal.hidden) return;
  if (e.code === 'Space' || e.key.toLowerCase() === 'x') { e.preventDefault(); doAttack(); }
  else if (!e.repeat && e.key >= '1' && e.key <= String(WEAPONS.length)) selectWeapon(Number(e.key) - 1);
});

// ---- HUD: ranking, vida e arma ----
function updateArenaHud() {
  const arena = isCombat();
  arenaRankEl.hidden = arenaBarEl.hidden = !arena;
  if (!arena) { arenaMsgEl.hidden = true; return; }
  arenaRankEl.querySelector('h4').textContent = currentMap === 'forest' ? '🌲 Ranking da floresta' : '⚔️ Ranking da arena';
  const me = arenaById[myId()];
  const hp = me ? me.hp : 100;
  arenaHpFill.style.width = hp + '%';
  arenaHpText.textContent = `${hp} / 100`;
  [...weaponsEl.children].forEach((b, i) => b.classList.toggle('sel', i === myWeapon));
  arenaMsgEl.hidden = arenaMeAlive();
  if (!arenaMsgEl.hidden) arenaMsgEl.textContent = currentMap === 'forest' ? '💀 Você caiu! Voltando à cidade em 3 segundos...' : '💀 Você caiu! Voltando à arena em 3 segundos...';
  arenaRankList.replaceChildren(...arenaList.filter(p => p.map === currentMap).slice(0, 5).map((p, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span'), pts = document.createElement('span');
    name.textContent = `${i + 1}. ${p.name}`; // textContent: nomes nunca viram HTML
    pts.textContent = p.score;
    li.append(name, pts);
    if (p.id === myId()) li.className = 'me';
    return li;
  }));
}

// jogador caído fica meio transparente (fantasma) até voltar
function setGhost(id, on) {
  const sp = id === myId() ? localSprite : remotePlayers[id]?.rect;
  if (!sp) return;
  const gif = [...gifSprites].find(g => g.sprite === sp);
  if (gif) gif.img.style.opacity = on ? 0.35 : 1;
  else sp.setAlpha(on ? 0.35 : 1);
}

// barras de vida sobre o nome de quem está na arena
function drawArenaBars() {
  if (!barsGfx) barsGfx = gameScene.add.graphics().setDepth(6);
  barsGfx.clear();
  if (!isCombat()) return;
  for (const sl of Object.values(slimes)) { // vida dos slimes feridos
    if (sl.hp >= sl.max || !sl.c.visible || sl.dead) continue;
    const m = sl.mult || 1, w = 34 + 8 * m, h = 5, x = sl.c.x - w / 2, y = sl.c.y - 32 * m - 6, pct = Phaser.Math.Clamp(sl.hp / sl.max, 0, 1);
    barsGfx.fillStyle(0x000000, 0.7).fillRect(x - 1, y - 1, w + 2, h + 2);
    barsGfx.fillStyle(0xe74c3c, 1).fillRect(x, y, w * pct, h);
  }
  for (const p of arenaList) {
    if (!p.alive || !isHere(p.id)) continue;
    const label = p.id === myId() ? nameLabel : remotePlayers[p.id]?.label;
    if (!label) continue;
    const w = 46, h = 6, x = label.x - w / 2, y = label.y - label.height - 9;
    const pct = Phaser.Math.Clamp(p.hp / 100, 0, 1);
    barsGfx.fillStyle(0x000000, 0.7).fillRect(x - 1, y - 1, w + 2, h + 2);
    barsGfx.fillStyle(pct > 0.5 ? 0x4cd964 : pct > 0.25 ? 0xf5c542 : 0xe74c3c, 1).fillRect(x, y, w * pct, h);
  }
}

// ---- Efeitos de golpe (desenhados por código) ----
function swingFx(id, weapon, dir) {
  const p = spritePos(id);
  if (!p || !isHere(id)) return;
  const x = p.x + dir * 14, y = p.y - 6;
  sfxAttack(weapon);
  const g = gameScene.add.graphics().setDepth(7).setPosition(x, y).setScale(dir, 1);
  const done = () => g.destroy();
  if (weapon === 0) { // espada: meia-lua prateada
    g.lineStyle(7, 0xffffff, 0.95).beginPath().arc(0, 0, 48, -1.1, 1.1).strokePath();
    g.lineStyle(3, 0x9fd8ff, 0.9).beginPath().arc(0, 0, 57, -1.1, 1.1).strokePath();
    g.setScale(0.7 * dir, 0.8);
    gameScene.tweens.add({ targets: g, scaleX: 1.15 * dir, scaleY: 1, alpha: 0, duration: 230, ease: 'Quad.Out', onComplete: done });
  } else if (weapon === 1) { // lança: estocada longa
    g.lineStyle(5, 0x8a5a2b, 1).lineBetween(0, 0, 105, 0);
    g.fillStyle(0xeeeeee, 1).fillTriangle(105, -8, 130, 0, 105, 8);
    g.setScale(0.2 * dir, 1);
    gameScene.tweens.add({ targets: g, scaleX: dir, alpha: 0, duration: 260, ease: 'Quad.Out', onComplete: done });
  } else if (weapon === 2) { // arco: arco curvo com a corda
    g.lineStyle(4, 0x8a5a2b, 1).beginPath().arc(0, 0, 22, -1.0, 1.0).strokePath();
    g.lineStyle(1, 0xffffff, 0.9).lineBetween(Math.cos(1.0) * 22, Math.sin(1.0) * 22, Math.cos(-1.0) * 22, Math.sin(-1.0) * 22);
    gameScene.tweens.add({ targets: g, alpha: 0, duration: 200, onComplete: done });
  } else if (weapon === 3) { // martelo: arco pesado + onda de choque no chão
    g.lineStyle(11, 0xffb347, 0.9).beginPath().arc(0, 0, 58, -1.6, 0.5).strokePath();
    g.setScale(0.6 * dir, 0.7);
    gameScene.tweens.add({ targets: g, scaleX: 1.1 * dir, scaleY: 1, alpha: 0, duration: 300, ease: 'Quad.Out', onComplete: done });
    const wave = gameScene.add.graphics().setDepth(6).setPosition(p.x + dir * 54, GROUND_TOP - 4);
    wave.lineStyle(4, 0xffe08a, 1).strokeEllipse(0, 0, 80, 16);
    wave.setScale(0.3);
    gameScene.tweens.add({ targets: wave, scale: 1.7, alpha: 0, duration: 380, delay: 90, onComplete: () => wave.destroy() });
  } else { // garras: três riscos
    for (const [ox, c, w] of [[-10, 0xff4040, 4], [0, 0xffffff, 5], [10, 0xff4040, 4]]) g.lineStyle(w, c, 0.95).lineBetween(ox, -28, ox + 30, 28);
    gameScene.tweens.add({ targets: g, scaleX: 1.25 * dir, alpha: 0, duration: 210, ease: 'Quad.Out', onComplete: done });
  }
}

function hitFx(x, y, dmg) {
  for (let i = 0; i < 9; i++) {
    const a = (Math.PI * 2 * i) / 9 + Math.random() * 0.5;
    const c = gameScene.add.circle(x, y - 6, 2 + Math.random() * 2, i % 2 ? 0xffe066 : 0xffffff).setDepth(8);
    gameScene.tweens.add({ targets: c, x: x + Math.cos(a) * 34, y: y - 6 + Math.sin(a) * 34, alpha: 0, duration: 320, onComplete: () => c.destroy() });
  }
  const t = gameScene.add.text(x, y - 50, '-' + dmg, { fontSize: '20px', fontStyle: 'bold', color: '#ff5252', stroke: '#000', strokeThickness: 4 })
    .setOrigin(0.5).setDepth(9);
  gameScene.tweens.add({ targets: t, y: t.y - 34, alpha: 0, duration: 750, ease: 'Quad.Out', onComplete: () => t.destroy() });
}

function deathFx(x, y, color = 0xe74c3c) {
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 50;
    const c = gameScene.add.circle(x, y, 3 + Math.random() * 3, i % 3 ? color : 0xffffff).setDepth(8);
    gameScene.tweens.add({ targets: c, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d - 20, alpha: 0, duration: 600, onComplete: () => c.destroy() });
  }
  const t = gameScene.add.text(x, y - 40, '💀', { fontSize: '30px' }).setOrigin(0.5).setDepth(9);
  gameScene.tweens.add({ targets: t, y: t.y - 40, alpha: 0, duration: 1100, onComplete: () => t.destroy() });
}

// flechas: o servidor decide o acerto; aqui só voam com a mesma velocidade
function spawnArrow(arrowId, x, y, dir) {
  const g = gameScene.add.graphics().setDepth(7).setPosition(x, y).setScale(dir, 1);
  g.lineStyle(3, 0x8a5a2b, 1).lineBetween(-22, 0, 4, 0);
  g.fillStyle(0xdddddd, 1).fillTriangle(4, -4, 12, 0, 4, 4);
  g.lineStyle(2, 0xffffff, 0.9).lineBetween(-22, -3, -17, 0).lineBetween(-22, 3, -17, 0);
  arrows[arrowId] = { g, dir, traveled: 0 };
}
function updateArrows(delta) {
  for (const id in arrows) {
    const a = arrows[id], step = ARROW_SPEED * delta / 1000;
    a.g.x += a.dir * step; a.traveled += step;
    if (a.traveled >= ARROW_RANGE || !isCombat()) { a.g.destroy(); delete arrows[id]; }
  }
}

// ---- Eventos vindos do servidor ----
function setupArenaEvents() {
  connection.on('PlayerMap', (id, map, x, y) => {
    if (id === myId()) {
      if (map !== currentMap) applyMap(map);
      player.body.reset(x, y);
      pushUntil = 0; dashUntil = 0; edgeHold = 0; mapRequestAt = Date.now() - 1500;
      localDancing = false;
      if (map === 'arena' || map === 'forest') connection.invoke('SetWeapon', myWeapon).catch(() => {});
      updateArenaHud();
      return;
    }
    const r = remotePlayers[id];
    if (!r) return;
    r.map = map; r.targetX = x; r.targetY = y;
    r.rect.setPosition(x, y);
    r.dancing = false;
    syncVisibility(id);
  });

  connection.on('ArenaState', list => {
    arenaList = list;
    arenaById = Object.fromEntries(list.map(p => [p.id, p]));
    for (const p of list) setGhost(p.id, !p.alive);
    if (!arenaById[myId()]) setGhost(myId(), false);
    updateArenaHud();
  });

  connection.on('ArenaSwing', (id, weapon, dir) => {
    swingFx(id, weapon, dir);
    (id === myId() ? localSprite : remotePlayers[id]?.rect)?.swingWeapon?.(); // o boneco dá a golpeada com a arma na mão
  });
  connection.on('ArrowFired', (arrowId, owner, x, y, dir) => { if (isCombat() && isHere(owner)) spawnArrow(arrowId, x, y, dir); });
  connection.on('SlimeState', list => syncSlimes(list));

  connection.on('ArenaHit', (attackerId, victimId, dmg, hp, dir, knock, lift, arrowId) => {
    if (arrowId && arrows[arrowId]) { arrows[arrowId].g.destroy(); delete arrows[arrowId]; }
    if (victimId.startsWith('slime:')) { // um slime apanhou
      const sl = slimes[victimId];
      if (sl && currentMap === 'forest') { sl.hp = hp; sl.flash = 6; hitFx(sl.c.x, sl.c.y - 14 * (sl.mult || 1), dmg); sfxHurt(false); }
      return;
    }
    if (!isHere(victimId)) return;
    const v = arenaById[victimId];
    if (v) { v.hp = hp; updateArenaHud(); }
    const p = spritePos(victimId);
    if (p) hitFx(p.x, p.y, dmg);
    sfxHurt(victimId === myId());
    const sprite = victimId === myId() ? localSprite : remotePlayers[victimId]?.rect;
    setRedFlash(sprite, true);
    setTimeout(() => { if (!isIt(victimId)) setRedFlash(sprite, false); }, 140);
    if (victimId === myId()) { // empurrão do golpe
      pushVX = dir * knock; pushUntil = gameScene.time.now + PUSH_MS;
      player.body.setVelocityY(-lift);
      gameScene.cameras.main.shake(130, 0.004);
    }
  });

  connection.on('ArenaKill', (killerId, victimId, lvl) => {
    if (victimId.startsWith('slime:')) { // um slime foi derrotado
      const sl = slimes[victimId];
      if (sl && currentMap === 'forest') { deathFx(sl.c.x, sl.c.y - 14 * (sl.mult || 1), SLIME_COLORS[Math.min(sl.lvl, 4)][1]); chip([660, 880, 1320, 1760], 0.04, 'square', 0.1); sl.c.setVisible(false); sl.dead = true; }
      if (killerId === myId()) addChatLine(null, lvl > 0 ? `🟢 Você derrotou um slime gigante (${[1, 2, 4, 8, 10][lvl]}x)! +${5 * [1, 2, 4, 8, 10][lvl]} pontos` : '🟢 Você derrotou um slime! (+5 pontos)', true);
      return;
    }
    if (!isHere(victimId)) return;
    const p = spritePos(victimId);
    if (p) deathFx(p.x, p.y);
    sfxDeath();
    const kn = killerId === myId() ? 'Você' : killerId.startsWith('slime:') ? 'Um slime' : remotePlayers[killerId]?.name || 'Alguém';
    const vn = victimId === myId() ? 'você' : remotePlayers[victimId]?.name || 'alguém';
    addChatLine(null, `⚔️ ${kn} derrotou ${vn}!`, true);
  });

  connection.on('PlayerDash', (id, dir) => dashFx(id, dir));
}

// ---- Ajuda da arena (botão ? mostra só isto enquanto o jogador está na arena) ----
const ARENA_HELP = [
  '⚔️ Arena: aqui você luta contra os outros jogadores. Cada um começa com 100 de vida; ao chegar a zero, você volta ao ponto de entrada depois de 3 segundos.',
  '🗡️ Atacar: aperte Espaço (ou X). O golpe vai para o lado em que você está virado. No celular, use o botão 🗡️.',
  '🎒 Armas: teclas 1 a 5 ou toque nos ícones embaixo — ⚔️ Espada (equilibrada), 🔱 Lança (alcance longo), 🏹 Arco (flecha à distância), 🔨 Martelo (lento, forte e empurra longe), 🐾 Garras (rápidas, dano baixo).',
  '🏆 Pontos: +1 por golpe que acerta e +10 por derrotar alguém. O ranking fica no canto superior esquerdo.',
  '💨 Dash: toque duas vezes rápido na seta ← ou →. Vale também no ar! (No celular, empurre a bolinha duas vezes rápido para o lado.)',
  '🚪 Sair: ande até o começo da arena (esquerda) e segure ← por um instante para voltar ao vilarejo.',
  'Na arena não dá para subir nas costas, dançar, empurrar ou cumprimentar. Emotes: botão 😀 ou /emote N (de 1 a 6).',
];
Object.assign(HELP, {
  arena: [
    '⚔️ Arena: ande até o fim da rua, à direita (onde está a placa), e segure → por um instante para entrar. Lá você luta com armas, ganha pontos e aparece no ranking.',
    'Dentro da arena, o botão ? mostra as instruções de combate. Para voltar, segure ← no começo da arena.',
  ],
  floresta: [
    '🌲 Floresta: ande até o fim da rua, à esquerda (onde está a placa), e segure ← por um instante. Tem música heroica e slimes 🟢 para derrotar.',
    'Lá você tem vida (100), escolhe a arma com as teclas 1 a 5 e ataca com Espaço ou X, como na arena — mas os jogadores NÃO se machucam entre si, só os slimes. Slime derrotado dá +5 pontos e volta depois de um tempo.',
    'Cuidado: cada jogador que um slime derrota faz ele dobrar de tamanho, vida e dano (até 10x) e mudar de cor — verde, azul, amarelo, laranja e roxo. Derrotar um slime grande vale mais pontos (5 × o tamanho). Encostar num slime tira vida. Se a vida acabar, você volta para a cidade principal depois de 3 segundos. Para voltar ao vilarejo, ande até o fim da floresta, à direita, e segure →. Dá para cumprimentar, dançar e subir nas costas de amigos lá também.',
  ],
  dash: [
    '💨 Dash: toque duas vezes rápido na seta ← ou → para dar um pequeno impulso. Vale também no ar! Depois há uma pequena pausa antes de usar de novo.',
    'No celular, empurre a bolinha da esquerda duas vezes rápido para o lado.',
  ],
});
HELP_GROUPS.push({ title: '💨 Movimento, floresta e arena', keys: ['dash', 'floresta', 'arena'] });

function refreshHelpForMap() {
  const arena = currentMap === 'arena';
  let box = document.getElementById('helpArena');
  if (!box) {
    box = document.createElement('div');
    box.id = 'helpArena';
    for (const line of ARENA_HELP) { const p = document.createElement('p'); p.textContent = line; p.style.margin = '8px 0'; p.style.fontSize = '13px'; box.appendChild(p); }
    document.getElementById('helpGroups').after(box);
  }
  box.hidden = !arena;
  document.getElementById('helpGroups').hidden = arena;
  document.querySelector('#helpPanel h3 span').textContent = arena ? '❓ Ajuda: Arena' : '❓ Ajuda: comandos e controles';
}


// ======================= Slimes da floresta =======================
// O servidor move e ataca os slimes (SlimeState a cada ~100 ms); aqui eles só são desenhados e suavizados.
// Cada jogador que um slime derrota dobra o tamanho dele (1x, 2x, 4x, 8x e no máximo 10x) e muda a cor.
const slimes = {}; // id -> { c (contêiner), g (desenho), x, y (alvo), hp, max, dir, hop, lvl, mult, flash }
const SLIME_COLORS = [ // [contorno, corpo, brilho] por nível
  [0x2f9e2a, 0x56d64a, 0xc9f7b5], // 1x verde
  [0x1f7fa0, 0x3fc1e0, 0xc8f1fb], // 2x azul-ciano
  [0xa8860f, 0xf1d54a, 0xfff5b8], // 4x amarelo
  [0xa5410e, 0xf08a2e, 0xffd9b0], // 8x laranja
  [0x6e1a6b, 0xb04de0, 0xf0c8ff], // 10x roxo (máximo)
];

function drawSlime(g, lvl) {
  const [edge, body, shine] = SLIME_COLORS[Math.min(lvl || 0, SLIME_COLORS.length - 1)];
  g.clear();
  g.fillStyle(0x000000, 0.25).fillEllipse(0, 0, 38, 8); // sombra no chão
  g.fillStyle(edge, 1).fillEllipse(0, -13, 40, 28); // contorno
  g.fillStyle(body, 1).fillEllipse(0, -13, 36, 25); // corpo
  g.fillStyle(shine, 0.9).fillEllipse(-8, -20, 10, 6); // brilho
  g.fillStyle(shine, 0.55).fillEllipse(9, -8, 6, 4); // segundo brilho (slimes são só uma gosma: sem olhos nem boca)
  if (lvl >= 4) g.fillStyle(0xffe066, 1).fillTriangle(-9, -26, -5, -34, -1, -26).fillTriangle(-1, -26, 3, -35, 7, -26).fillTriangle(7, -26, 10, -33, 13, -26); // coroa do slime máximo
}

function makeSlimeSprite(scene, lvl) {
  const g = scene.add.graphics();
  drawSlime(g, lvl);
  return { c: scene.add.container(0, 0, [g]).setDepth(0.5), g };
}

function evolveFx(sl) { // estouro de partículas na cor nova e um som que sobe
  const color = SLIME_COLORS[Math.min(sl.lvl, SLIME_COLORS.length - 1)][1], cx = sl.c.x, cy = sl.c.y - 14 * sl.mult;
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2, d = (30 + Math.random() * 40) * Math.sqrt(sl.mult);
    const p = gameScene.add.circle(cx, cy, 3 + Math.random() * 3, i % 3 ? color : 0xffffff).setDepth(8);
    gameScene.tweens.add({ targets: p, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, alpha: 0, duration: 650, onComplete: () => p.destroy() });
  }
  chip([262, 330, 392, 523, 659, 784], 0.05, 'square', 0.12);
  sl.pop = 10;
}

function syncSlimes(list) {
  const seen = new Set();
  for (const d of list) {
    seen.add(d.id);
    let sl = slimes[d.id];
    if (!sl) {
      if (!gameScene) continue;
      const made = makeSlimeSprite(gameScene, d.lvl);
      sl = slimes[d.id] = { ...made, hp: d.hp, max: d.max, flash: 0, dead: false, lvl: d.lvl, mult: d.mult, pop: 0 };
      sl.c.setPosition(d.x, d.y + 14 * d.mult);
    }
    if (sl.dead) { sl.dead = false; sl.c.setPosition(d.x, d.y + 14 * d.mult); } // voltou a viver
    const evolved = d.lvl > sl.lvl, reset = d.lvl < sl.lvl;
    Object.assign(sl, { x: d.x, y: d.y, hp: d.hp, max: d.max, dir: d.dir, hop: d.hop, lvl: d.lvl, mult: d.mult });
    if (evolved || reset) drawSlime(sl.g, sl.lvl);
    if (evolved && currentMap === 'forest') evolveFx(sl);
  }
  for (const id in slimes) if (!seen.has(id)) { slimes[id].c.destroy(); delete slimes[id]; }
}

function updateSlimes() {
  const forest = currentMap === 'forest';
  const now = Date.now();
  for (const sl of Object.values(slimes)) {
    sl.c.setVisible(forest && !sl.dead);
    if (!forest || sl.dead) continue;
    const m = sl.mult || 1;
    sl.c.x += (sl.x - sl.c.x) * 0.4;
    sl.c.y += (sl.y + 14 * m - sl.c.y) * 0.5;
    const hopping = sl.hop > 1; // no ar: esticado; no chão: respira
    const pop = sl.pop > 0 ? 1 + sl.pop * 0.03 : 1; // "pulinho" de tamanho ao evoluir
    if (sl.pop > 0) sl.pop--;
    sl.c.scaleX = (hopping ? 0.88 : 1 + Math.sin(now / 220) * 0.04) * (sl.dir || 1) * m * pop;
    sl.c.scaleY = (hopping ? 1.14 : 1 - Math.sin(now / 220) * 0.04) * m * pop;
    if (sl.flash > 0) { sl.flash--; sl.c.setAlpha(sl.flash % 2 ? 0.45 : 1); } else sl.c.setAlpha(1);
  }
}
