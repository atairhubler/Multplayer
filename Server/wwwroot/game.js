// URL do backend no Render (troque após criar o serviço)
const PRODUCTION_URL = 'https://plataforma-multiplayer.onrender.com';
const SERVER_URL = location.hostname.endsWith('github.io') ? PRODUCTION_URL
  : location.protocol.startsWith('http') ? location.origin : 'http://localhost:5000';

const COLORS = { red: 0xe74c3c, blue: 0x3498db, green: 0x2ecc71, yellow: 0xf1c40f };
const SEND_INTERVAL_MS = 50; // throttle: ~20 envios/s

let connection;
let myName = '';
let myCharacter = 'red';

document.getElementById('join').addEventListener('click', async () => {
  myName = document.getElementById('name').value.trim() || 'Jogador';
  myCharacter = document.querySelector('input[name=char]:checked').value;
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
  startPhaser();
});

function startPhaser() {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 800,
    height: 600,
    backgroundColor: '#87ceeb',
    physics: { default: 'arcade', arcade: { gravity: { y: 800 }, debug: false } },
    scene: { create, update }
  });
}

const remotePlayers = {}; // id -> { rect, label, targetX, targetY }
let player, nameLabel, cursors, lastSent = 0, lastX = 0, lastY = 0;

function makeRect(scene, color) {
  return scene.add.rectangle(0, 0, 32, 48, color);
}

function createRemote(scene, p) {
  if (remotePlayers[p.id]) return;
  const rect = makeRect(scene, COLORS[p.characterSprite] ?? 0xffffff).setPosition(p.x, p.y);
  const label = scene.add.text(p.x, p.y - 38, p.name, {
    fontSize: '14px', color: '#fff', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5);
  remotePlayers[p.id] = { rect, label, targetX: p.x, targetY: p.y };
}

function create() {
  const scene = this;

  // Mapa: chão + 3 plataformas (retângulos estáticos)
  const platforms = this.physics.add.staticGroup();
  const addPlatform = (x, y, w, h, color) => {
    const r = this.add.rectangle(x, y, w, h, color);
    this.physics.add.existing(r, true);
    platforms.add(r);
  };
  addPlatform(400, 580, 800, 40, 0x228b22); // chão
  addPlatform(200, 450, 200, 20, 0x8b5a2b);
  addPlatform(520, 340, 200, 20, 0x8b5a2b);
  addPlatform(150, 220, 160, 20, 0x8b5a2b);

  // Jogador local
  player = makeRect(this, COLORS[myCharacter]);
  this.physics.add.existing(player);
  player.x = 100; player.y = 400;
  player.body.setCollideWorldBounds(true);
  this.physics.add.collider(player, platforms);
  nameLabel = this.add.text(0, 0, myName, {
    fontSize: '14px', color: '#fff', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5);

  cursors = this.input.keyboard.createCursorKeys();

  // Handlers do SignalR (nomes em camelCase vindos do JSON)
  connection.on('ExistingPlayers', list => list.forEach(p => createRemote(scene, p)));
  connection.on('PlayerJoined', p => createRemote(scene, p));
  connection.on('PlayerMoved', (id, x, y) => {
    const r = remotePlayers[id];
    if (r) { r.targetX = x; r.targetY = y; }
  });
  connection.on('PlayerLeft', id => {
    const r = remotePlayers[id];
    if (!r) return;
    r.rect.destroy();
    r.label.destroy();
    delete remotePlayers[id];
  });

  connection.invoke('JoinGame', myName, myCharacter);
}

function update(time) {
  const body = player.body;
  if (cursors.left.isDown) body.setVelocityX(-200);
  else if (cursors.right.isDown) body.setVelocityX(200);
  else body.setVelocityX(0);

  if (cursors.up.isDown && body.blocked.down) body.setVelocityY(-500);

  nameLabel.setPosition(player.x, player.y - 38);

  // Envia posição só se mudou, com throttle
  if (time - lastSent > SEND_INTERVAL_MS &&
      (Math.abs(player.x - lastX) > 0.5 || Math.abs(player.y - lastY) > 0.5)) {
    connection.invoke('UpdatePosition', player.x, player.y);
    lastSent = time; lastX = player.x; lastY = player.y;
  }

  // Interpolação suave dos remotos
  for (const id in remotePlayers) {
    const r = remotePlayers[id];
    r.rect.x = Phaser.Math.Linear(r.rect.x, r.targetX, 0.25);
    r.rect.y = Phaser.Math.Linear(r.rect.y, r.targetY, 0.25);
    r.label.setPosition(r.rect.x, r.rect.y - 38);
  }
}
