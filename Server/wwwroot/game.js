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
// quem está carregando alguém tem o nome e o balão mais acima, para não ficarem por cima de quem está nas costas
const liftFor = id => (Object.values(ridingMap).includes(id) ? CHAR_H * 0.72 + 34 : 0);

const isIt = id => tagState.active && tagState.itId === id;

// Nome (com o título numa linha acima), na cor escolhida; o pegador do pique-pega aparece em vermelho
function refreshLabel(id) {
  const info = id === myId() ? localInfo : remotePlayers[id];
  if (!info || !info.label) return;
  const it = isIt(id);
  info.label.setText((it ? '🔴 ' : '') + (info.title ? info.title + '\n' : '') + info.name);
  info.label.setColor(it ? '#ff6b6b' : info.nameColor || '#ffffff');
}
const refreshAllLabels = () => { refreshLabel(myId()); Object.keys(remotePlayers).forEach(refreshLabel); };
const placeLabel = (label, x, y) => label.setPosition(x, y - LABEL_DY + 9);

function createRemote(scene, p, announce = false) {
  if (remotePlayers[p.id]) return;
  const rect = makeSprite(scene, p.characterSprite || 'red').setPosition(p.x, p.y);
  if (announce) { addChatLine(null, p.name + ' entrou'); playChime(); }
  const label = scene.add.text(p.x, p.y, p.name, LABEL_STYLE).setOrigin(0.5, 1);
  remotePlayers[p.id] = {
    rect, label, name: p.name, title: p.title || null, nameColor: p.nameColor || null,
    dancing: !!p.dancing, targetX: p.x, targetY: p.y,
  };
  if (p.ridingOn) { ridingMap[p.id] = p.ridingOn; rect.setDepth(2); }
  refreshLabel(p.id);
  renderOnline();
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
    const anchor = id === connection.connectionId ? localSprite : remotePlayers[id]?.rect;
    if (!anchor || now > b.expires) { b.text.destroy(); delete bubbles[id]; continue; }
    const half = b.text.width / 2;
    b.text.setPosition(Phaser.Math.Clamp(anchor.x, half, WORLD_W - half), anchor.y - BUBBLE_DY - liftFor(id));
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
  connection.on('SystemMessage', text => String(text).split('\n').forEach(l => addChatLine(null, l)));
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
    addChatLine(null, r.name + ' saiu');
    r.rect.destroy();
    r.label.destroy();
    delete remotePlayers[id];
    delete ridingMap[id];
    renderOnline();
  });

  connection.invoke('JoinGame', myName, myCharacter);
  // cor do nome e título (se o servidor for antigo e não tiver o método, ignora o erro)
  connection.invoke('UpdateProfile', localInfo.nameColor, localInfo.title).catch(() => {});
}

function update(time, delta) {
  const body = player.body;
  const typing = document.activeElement === chatInput;
  const left = (!typing && cursors.left.isDown) || touch.left;
  const right = (!typing && cursors.right.isDown) || touch.right;
  const jump = (!typing && cursors.up.isDown) || touch.jump;
  const carrierId = ridingMap[myId()];
  const carrier = carrierId && remotePlayers[carrierId];

  if (carrier) { // nas costas de alguém: acompanha o carregador; pular desce
    player.setPosition(carrier.rect.x, carrier.rect.y);
    if (jump && !jumpLatch) doRide();
  } else {
    if (time < pushUntil) body.setVelocityX(pushVX * (pushUntil - time) / PUSH_MS); // empurrão que vai perdendo força
    else if (left) body.setVelocityX(-200);
    else if (right) body.setVelocityX(200);
    else body.setVelocityX(0);

    if (jump && body.blocked.down) body.setVelocityY(-500);
    if (localDancing && (left || right || jump)) setDancing(false); // andar interrompe a dança
  }
  jumpLatch = jump;

  if (carrier) {
    localSprite.setPosition(player.x, player.y - CHAR_H * 0.72);
    localSprite.animate?.(false, false, 0, delta, false);
  } else {
    localSprite.setPosition(player.x, player.y);
    const vx = body.velocity.x;
    localSprite.animate?.(Math.abs(vx) > 10, !body.blocked.down, vx, delta, localDancing);
  }
  if (!localSprite.animate && localSprite.setAngle) localSprite.angle = localDancing ? Math.sin(Date.now() / 150) * 10 : 0;
  placeLabel(nameLabel, localSprite.x, localSprite.y - liftFor(myId()));

  // Envia posição só se mudou, com throttle
  if (!carrier && time - lastSent > SEND_INTERVAL_MS &&
      (Math.abs(player.x - lastX) > 0.5 || Math.abs(player.y - lastY) > 0.5)) {
    connection.invoke('UpdatePosition', player.x, player.y);
    lastSent = time; lastX = player.x; lastY = player.y;
  }

  updateBubbles(time);

  // Remotos: interpolação suave, ou posição presa ao carregador quando estão nas costas de alguém
  for (const id in remotePlayers) {
    const r = remotePlayers[id];
    const cId = ridingMap[id];
    const src = cId === myId() ? player : remotePlayers[cId]?.rect;
    if (cId && src) {
      r.rect.setPosition(src.x, src.y - CHAR_H * 0.72);
      r.targetX = src.x; r.targetY = src.y;
      r.rect.animate?.(false, false, 0, delta, false);
    } else {
      const dx = r.targetX - r.rect.x, dy = r.targetY - r.rect.y;
      r.rect.x = Phaser.Math.Linear(r.rect.x, r.targetX, 0.25);
      r.rect.y = Phaser.Math.Linear(r.rect.y, r.targetY, 0.25);
      r.rect.animate?.(Math.abs(dx) > 0.8, Math.abs(dy) > 2, dx, delta, r.dancing);
    }
    if (!r.rect.animate && r.rect.setAngle) r.rect.angle = r.dancing ? Math.sin(Date.now() / 150) * 10 : 0;
    placeLabel(r.label, r.rect.x, r.rect.y - liftFor(id));
  }
  updateInteractHint(carrier);
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
  onlineEl.style.top = r.top + 8 + 'px';
  onlineEl.style.right = innerWidth - r.right + 8 + 'px';
  emoteTray.style.bottom = innerHeight - r.bottom + 84 + 'px';
  hudEl.style.left = interactHint.style.left = r.left + r.width / 2 + 'px';
  hudEl.style.top = r.top + 8 + 'px';
  interactHint.style.top = r.top + 44 + 'px';
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
  connection.on('ChatMessage', m => { addChatLine(m.name, m.text); showBubble(m.id, m.text); });
  chatReady = true;
  // depois do histórico, que chega logo ao entrar
  setTimeout(() => addChatLine(null, `👋 Bem-vindo, ${myName}! Digite /comandos para ver tudo que você pode fazer.`), 700);
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
  const doll = scene.add.container(0, 0, [rig]).setScale(CHAR_SCALE);
  let phase = 0, dir = 1;

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
    const k = 1 - Math.exp(-dt * 0.02); // suaviza a transição entre poses
    const ease = (obj, target) => { obj.rotation += (target - obj.rotation) * k; };
    ease(part.armNear, aN); ease(part.armFar, aF);
    ease(part.legNear, lN); ease(part.legFar, lF);
    rig.y += (bob - rig.y) * k;
    rig.rotation += (sway - rig.rotation) * k;
  };
  return doll;
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
  const names = [{ name: myName + ' (você)', me: true }, ...Object.values(remotePlayers).map(r => ({ name: r.name }))];
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
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !chatBar.hidden) return;
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
const music = { ctx: null, master: null, bus: null, timer: null, step: 0, muted: false };
try { music.muted = localStorage.getItem('muted') === '1'; } catch {}
const muteBtn = document.getElementById('muteBtn');
muteBtn.textContent = music.muted ? '🔇' : '🔊';

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
      music.sfx.gain.value = music.muted ? 0 : 0.5;
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

muteBtn.addEventListener('click', () => {
  music.muted = !music.muted;
  muteBtn.textContent = music.muted ? '🔇' : '🔊';
  try { localStorage.setItem('muted', music.muted ? '1' : '0'); } catch {}
  unlockAudio();
  if (music.master) music.master.gain.setTargetAtTime(music.muted ? 0 : MUSIC_VOLUME, music.ctx.currentTime, 0.15);
  if (music.sfx) music.sfx.gain.setTargetAtTime(music.muted ? 0 : 0.5, music.ctx.currentTime, 0.15);
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
let currentSpot = -1;

function updateInteractHint(riding) {
  const spot = riding ? -1 : SPOTS.findIndex(sp => Math.abs(player.x - sp.x) < sp.range);
  if (spot === currentSpot) return;
  currentSpot = spot;
  interactHint.hidden = spot < 0;
  if (spot >= 0) interactHint.textContent = (coarsePointer ? '👆 Toque: ' : 'Aperte E: ') + SPOTS[spot].text;
}

const doGreet = () => connection.invoke('Greet');
const doPush = () => connection.invoke('Push');
const doRide = () => connection.invoke('ToggleRide');
const setDancing = on => { localDancing = on; connection.invoke('SetDancing', on); };
const doDance = () => { if (!ridingMap[myId()]) setDancing(!localDancing); };
const doInteract = () => {
  if (currentSpot >= 0) connection.invoke('Interact', currentSpot);
  else addChatLine(null, 'Chegue perto de um ponto do vilarejo: a fonte, as barracas, a padaria, a ferraria ou a porta da esquerda.');
};
interactHint.addEventListener('click', doInteract);

// Quem sobe/desce das costas de alguém
function onRiding(rid, cid, x, y) {
  if (cid) ridingMap[rid] = cid; else delete ridingMap[rid];
  const me = rid === myId();
  const sprite = me ? localSprite : remotePlayers[rid]?.rect;
  sprite?.setDepth(cid ? 2 : 0);
  if (me) {
    if (cid) { player.body.enable = false; player.body.setVelocity(0, 0); localDancing = false; }
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
  if (!music.ctx || !music.sfx || music.muted || music.ctx.state !== 'running') return;
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
    'Para descer, aperte R de novo ou pule. Quem está carregando também pode apertar R para derrubar quem está nas costas.',
  ],
  danca: [
    '💃 Dança: aperte G para começar a dançar (celular: botão 😀 e depois 💃). Aperte G de novo ou ande para parar.',
    'Quando vários amigos dançam juntos a dança fica sincronizada! Dançar por 90 segundos dá o título "Dançarino".',
  ],
  pique: [
    '🏃 Pique-pega: digite /pique iniciar para começar (mínimo de 2 jogadores, dura 90 segundos). /pique parar encerra.',
    'O pegador fica em vermelho 🔴: encoste em alguém para passar a vez (quem foi pego tem 2 segundos de proteção).',
    'Vence quem ficar menos tempo como pegador e ganha o título "Campeão do Pique-Pega". Quem está nas costas de alguém não pode ser pego.',
  ],
  vilarejo: [
    '🏘️ Vilarejo: ande até a fonte, as barracas, a padaria, a ferraria ou a porta da esquerda.',
    'Quando aparecer o aviso no topo da tela, aperte E (celular: toque no aviso) para interagir. Todos veem o que você fez.',
  ],
  titulo: null,
  cor: [
    '🎨 Cor do nome: digite /cor seguido de um código de cor, por exemplo /cor #ff8800. Você também escolhe na tela de entrada.',
  ],
};
const ALIASES = {
  ajuda: 'comandos', help: 'comandos', dancar: 'danca', costas: 'subir', montar: 'subir', carregar: 'subir',
  interagir: 'vilarejo', cumprimento: 'cumprimentar', empurrao: 'empurrar', titulos: 'titulo',
};
const say = lines => lines.forEach(l => addChatLine(null, l));

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
    ]);
  }
  if (cmd === 'emote' && /^[1-6]$/.test(args[0] || '')) return sendEmote(Number(args[0]) - 1);
  if (cmd === 'pique' && args[0]?.toLowerCase() === 'iniciar') return connection.invoke('StartTag');
  if (cmd === 'pique' && args[0]?.toLowerCase() === 'parar') return connection.invoke('StopTag');
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
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !chatReady || !chatBar.hidden) return;
  KEY_ACTIONS[e.key.toLowerCase()]?.();
});
[['🤝', 'Cumprimentar', doGreet], ['💢', 'Empurrar', doPush], ['🐴', 'Subir ou descer das costas', doRide],
 ['💃', 'Dançar', doDance], ['✋', 'Interagir', doInteract]].forEach(([icon, title, fn]) => {
  const b = document.createElement('button');
  b.textContent = icon; b.title = title;
  b.addEventListener('click', () => { fn(); emoteTray.classList.remove('open'); });
  emoteTray.appendChild(b);
});
