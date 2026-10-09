// URL do backend no Render (troque após criar o serviço)
const PRODUCTION_URL = 'https://plataforma-multiplayer.onrender.com';
const SERVER_URL = location.hostname.endsWith('github.io') ? PRODUCTION_URL
  : location.protocol.startsWith('http') ? location.origin : 'http://localhost:5000';

const COLORS = { red: 0xe74c3c, blue: 0x3498db, green: 0x2ecc71, yellow: 0xf1c40f };
const WORLD_W = 1280, VIEW_H = 600; // mapa inteiro sempre visível (escala FIT)
const SEND_INTERVAL_MS = 50; // throttle: ~20 envios/s

let connection;
let myName = '';
let myCharacter = 'red';
let customImage = null; // data URL do avatar enviado pelo usuário

// ---- Upload de avatar: recorta em 2:3, reduz para 64x96 e comprime ----
const fileInput = document.getElementById('avatarFile');
const preview = document.getElementById('avatarPreview');
const MAX_IMAGE_CHARS = 40000; // mesmo limite do servidor

function processImage(file) {
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
  if (!fileInput.files[0]) return;
  try {
    customImage = await processImage(fileInput.files[0]);
    preview.src = customImage;
    preview.hidden = false;
  } catch (e) {
    errorEl.textContent = e.message;
    fileInput.value = '';
  }
});
// Escolher uma cor descarta a imagem enviada
document.querySelectorAll('input[name=char]').forEach(r => r.addEventListener('change', () => {
  customImage = null; preview.hidden = true; fileInput.value = '';
}));

document.getElementById('join').addEventListener('click', async () => {
  myName = document.getElementById('name').value.trim() || 'Jogador';
  myCharacter = customImage || document.querySelector('input[name=char]:checked').value;
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';

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
  new Phaser.Game({
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

// Cria o sprite de um personagem: cor sólida, ou imagem enviada (carregada de forma assíncrona)
function makeSprite(scene, character) {
  const isImage = character.startsWith('data:image/');
  const sprite = scene.add.image(0, 0, isImage ? 'c_gray' : 'c_' + character).setDisplaySize(32, 48);
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

function update(time) {
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
    r.rect.x = Phaser.Math.Linear(r.rect.x, r.targetX, 0.25);
    r.rect.y = Phaser.Math.Linear(r.rect.y, r.targetY, 0.25);
    r.label.setPosition(r.rect.x, r.rect.y - 38);
  }
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
const chatOpenBtn = document.getElementById('chatOpen');

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
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  chatLog.appendChild(p);
  while (chatLog.children.length > 200) chatLog.firstChild.remove();
  if (atBottom || name === myName) chatLog.scrollTop = chatLog.scrollHeight;
}

function setChatOpen(open) {
  chatEl.classList.toggle('open', open);
  chatOpenBtn.classList.toggle('show', !open);
  window.dispatchEvent(new Event('resize')); // o Phaser reajusta o canvas à nova largura
}

function setupChat() {
  setChatOpen(innerWidth > 900); // em tela pequena começa recolhido
  document.getElementById('chatClose').onclick = () => setChatOpen(false);
  chatOpenBtn.onclick = () => setChatOpen(true);

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
  chatInput.focus();
}

function closeChatBar() {
  chatBar.hidden = true;
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
