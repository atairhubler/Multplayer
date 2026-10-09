// Interface do jogo: HUD do personagem (retrato, nível, barras), barra de ícones no topo direito e o Menu em tela cheia
// (grade de botões + janelas de Perfil, Classificação, Conquistas, Mapa e Configurações). Carregado depois do game.js:
// usa as variáveis e funções dele (connection, myCharacter, localInfo, arenaById, equipTitle, ...). Todo texto de usuário via textContent.

// ---------- Ícones (SVG simples desenhados por código, brancos) ----------
const ICON_PATHS = {
  profile: '<circle cx="12" cy="8" r="4.2"/><path d="M3.5 21.5c0-4.6 3.8-7.4 8.5-7.4s8.5 2.8 8.5 7.4z"/>',
  podium: '<rect x="9" y="9" width="6" height="12"/><rect x="2" y="14" width="6" height="7"/><rect x="16" y="16" width="6" height="5"/><path d="M12 1.5l1.5 3 3.3.5-2.4 2.3.6 3.3L12 9l-3 1.6.6-3.3-2.4-2.3 3.3-.5z"/>',
  trophy: '<path d="M7 3h10v6.5a5 5 0 0 1-10 0z"/><path d="M7 5H3v2.5a4 4 0 0 0 4 4zM17 5h4v2.5a4 4 0 0 1-4 4z"/><rect x="10.5" y="14.5" width="3" height="3.5"/><rect x="7" y="18" width="10" height="3" rx="1"/>',
  map: '<path d="M2 5.5l6.5-2.5 7 2.5 6.5-2.5v15.5l-6.5 2.5-7-2.5L2 21z"/><path d="M8.5 3v15.5M15.5 5.5V21" stroke="#2b3752" stroke-width="1.4" fill="none"/>',
  castle: '<path d="M2.5 21.5V8h3.5V5h2.5v3h2V5H13v3h2V5h2.5v3H21v13.5h-5.5v-5.2a3.5 3.5 0 0 0-7 0v5.2z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9 9.2a3 3 0 1 1 4.6 2.5c-1 .7-1.6 1.2-1.6 2.5" stroke="#2b3752" stroke-width="2.2" fill="none" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.3" fill="#2b3752"/>',
  gear: '<path d="M10.4 2h3.2l.5 2.6 1.6.7 2.2-1.5 2.3 2.3-1.5 2.2.7 1.6 2.6.5v3.2l-2.6.5-.7 1.6 1.5 2.2-2.3 2.3-2.2-1.5-1.6.7-.5 2.6h-3.2l-.5-2.6-1.6-.7-2.2 1.5-2.3-2.3 1.5-2.2-.7-1.6L2 13.6v-3.2l2.6-.5.7-1.6-1.5-2.2 2.3-2.3 2.2 1.5 1.6-.7z"/><circle cx="12" cy="12" r="3.2" fill="#2b3752"/>',
  grid: '<rect x="2.5" y="5.5" width="5" height="5.5" rx="1"/><rect x="9.5" y="5.5" width="5" height="5.5" rx="1"/><rect x="16.5" y="5.5" width="5" height="5.5" rx="1"/><rect x="2.5" y="13" width="5" height="5.5" rx="1"/><rect x="9.5" y="13" width="5" height="5.5" rx="1"/><rect x="16.5" y="13" width="5" height="5.5" rx="1"/>',
  bag: '<path d="M8.5 5.5V5a3.5 3.5 0 0 1 7 0v.5H18l1.5 15.5h-15L6 5.5z"/><rect x="9.5" y="10" width="5" height="3" rx="1" fill="#2b3752"/>',
  shop: '<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 8.5v3.2c0 1.8 3.6 3.3 8 3.3s8-1.5 8-3.3V8.5c-1.6 1.4-4.6 2.2-8 2.2s-6.4-.8-8-2.2zM4 14v3.2c0 1.8 3.6 3.3 8 3.3s8-1.5 8-3.3V14c-1.6 1.4-4.6 2.2-8 2.2S5.6 15.4 4 14z"/>',
  scroll: '<rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M9.3 9.4a2.7 2.7 0 1 1 4.1 2.2c-.9.6-1.4 1-1.4 2.1" stroke="#2b3752" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1.2" fill="#2b3752"/>',
  exit: '<path d="M10 3H4v18h6v-2H6V5h4zm5 4l5 5-5 5v-3.5H9v-3h6z"/>',
  star: '<path d="M12 2l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17l-5.9 3 1.2-6.5L2.5 8.9 9.1 8z"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" stroke="#fff" stroke-width="2" fill="none"/>',
};
function iconSvg(name, cls = '') {
  const d = document.createElement('span');
  d.className = 'ico ' + cls;
  d.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`; // só constantes deste arquivo
  return d;
}
const uiEl = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };

// ---------- Nível e pontos ----------
// Nível sobe com os pontos de combate (conta Google: o total salvo + o que você fez nesta sessão).
// Para o nível L (1, 2, 3...) são necessários 25 × (L−1)² pontos: 25, 100, 225, 400...
let lastSessionScore = 0;
function totalPoints() {
  const me = arenaById[myId()];
  if (me) lastSessionScore = Math.max(lastSessionScore, me.score);
  return Math.max(0, (accountInfo?.stats?.points || 0) + lastSessionScore);
}
function levelInfo(points) {
  const level = 1 + Math.floor(Math.sqrt(points / 25));
  const from = 25 * (level - 1) ** 2, to = 25 * level ** 2;
  return { level, from, to, pct: Math.min(1, Math.max(0, (points - from) / (to - from))) };
}

// ---------- HUD (retrato + barras, canto superior esquerdo) ----------
const ui = {
  hud: document.getElementById('playerHud'), face: document.getElementById('hudFace'), level: document.getElementById('hudLevel'),
  hpFill: document.getElementById('hudHpFill'), hpText: document.getElementById('hudHpText'),
  xpFill: document.getElementById('hudXpFill'), xpText: document.getElementById('hudXpText'),
  manaFill: document.getElementById('hudManaFill'), manaText: document.getElementById('hudManaText'),
  staminaFill: document.getElementById('hudStaminaFill'), staminaText: document.getElementById('hudStaminaText'),
  pointsValue: document.getElementById('pointsValue'), coinsValue: document.getElementById('coinsValue'),
};
// moedas: o total salvo na conta (vem em AccountData) + as pegas nesta sessão (contadas em coinTaken, no game.js)
const totalCoins = () => (accountInfo?.stats?.coins || 0) + sessionCoins;

async function drawPortrait(canvas, character, crop = true) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    if (character.startsWith('char:')) {
      const tmp = document.createElement('canvas'); tmp.width = 192; tmp.height = 240;
      await drawDollPreview(tmp, character);
      if (crop) ctx.drawImage(tmp, 44, 6, 120, 120, 0, 0, canvas.width, canvas.height); // cabeça e ombros
      else ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    } else {
      const img = new Image();
      img.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, img.width, crop ? img.width : img.height, 0, 0, canvas.width, canvas.height); };
      img.src = character.startsWith('/avatars/') ? SERVER_URL + character : character;
    }
  } catch { /* sem retrato: fica o fundo */ }
}

// ---------- Mana ----------
// Mana (barra azul): cada golpe gasta um pouco, conforme a arma, e ela recarrega sozinha (12 por segundo).
// Stamina (barra verde): o dash gasta 30 e ela recarrega devagar (7,3 por segundo, ~14 s para encher): uns 3 dashes seguidos e depois é esperar.
// As duas ficam só no seu navegador (o servidor não cobra), então servem para dar ritmo ao jogo; é fácil ajustar os valores abaixo.
const MANA_MAX = 100, MANA_REGEN_PER_S = 12, MANA_COST_WEAPON = [4, 6, 8, 12, 2]; // espada, lança, arco, martelo, garras
const STAMINA_MAX = 100, STAMINA_REGEN_PER_S = 7.3, STAMINA_COST_DASH = 30;
let manaValue = MANA_MAX, manaAt = Date.now(), staminaValue = STAMINA_MAX, staminaAt = Date.now();
function manaNow() {
  const now = Date.now();
  manaValue = Math.min(MANA_MAX, manaValue + (now - manaAt) / 1000 * MANA_REGEN_PER_S);
  manaAt = now;
  return manaValue;
}
function staminaNow() {
  const now = Date.now();
  staminaValue = Math.min(STAMINA_MAX, staminaValue + (now - staminaAt) / 1000 * STAMINA_REGEN_PER_S);
  staminaAt = now;
  return staminaValue;
}
function spendStamina(cost) {
  if (staminaNow() < cost) {
    const bar = ui.staminaFill.parentElement; bar.classList.add('low'); setTimeout(() => bar.classList.remove('low'), 350); // sem stamina: a barra pisca
    return false;
  }
  staminaValue -= cost;
  return true;
}
function spendMana(cost) {
  if (manaNow() < cost) {
    const bar = ui.manaFill.parentElement; bar.classList.add('low'); setTimeout(() => bar.classList.remove('low'), 350); // sem mana: a barra pisca
    return false;
  }
  manaValue -= cost;
  return true;
}

let hudKey = '';
function updateHud() {
  if (ui.hud.hidden) return;
  const pts = totalPoints(), lv = levelInfo(pts);
  const me = arenaById[myId()];
  const hp = isCombat() && me ? me.hp : 100;
  const mana = Math.floor(manaNow()), stamina = Math.floor(staminaNow());
  const coinsNow = totalCoins();
  const key = [hp, pts, lv.level, mana, stamina, coinsNow].join('|');
  if (key === hudKey) return;
  hudKey = key;
  ui.level.textContent = lv.level;
  ui.hpFill.style.width = hp + '%'; ui.hpText.textContent = `${hp} / 100`;
  ui.manaFill.style.width = mana + '%'; ui.manaText.textContent = `${mana} / ${MANA_MAX}`;
  ui.staminaFill.style.width = stamina + '%'; ui.staminaText.textContent = `${stamina} / ${STAMINA_MAX}`;
  ui.xpFill.style.width = lv.pct * 100 + '%'; ui.xpText.textContent = `XP ${pts} / ${lv.to}`;
  ui.pointsValue.textContent = pts; ui.coinsValue.textContent = coinsNow;
  const sp = document.getElementById('screenPoints'); if (sp) sp.textContent = `🪙 ${coinsNow}   ⭐ ${pts}`;
}

// posiciona o HUD e o resto relativos ao canvas do jogo (mesma ideia do positionChat)
function updateUi() {
  if (ui.hud.hidden) return;
  const r = phaserGame.canvas.getBoundingClientRect();
  ui.hud.style.left = r.left + 10 + 'px'; ui.hud.style.top = r.top + 8 + 'px';
  const desk = potionBtns[1]; // botão da poção no computador: círculo no canto inferior direito, acima do ? e da tela cheia
  if (desk) { desk.style.right = innerWidth - r.right + 12 + 'px'; desk.style.bottom = innerHeight - r.bottom + 58 + 'px'; }
  updateHud();
}

// ---------- Tela cheia do menu e janelas ----------
const infoModal = document.getElementById('infoModal'), infoTitle = document.getElementById('infoTitle'), infoBody = document.getElementById('infoBody');
const screenIcon = document.getElementById('screenIcon');
const settingsSource = document.getElementById('settingsSource');

function restoreSettingsButtons() { // os botões de música/efeitos moram no menu de configurações só enquanto ele está aberto
  for (const id of ['muteBtn', 'sfxBtn']) { const b = document.getElementById(id); if (b && b.parentElement !== settingsSource) settingsSource.appendChild(b); }
}
function openScreen(title, icon) {
  restoreSettingsButtons();
  potionWindow = null; // (as janelas de loja/inventário se marcam depois)
  infoTitle.textContent = title;
  screenIcon.replaceChildren(iconSvg(icon));
  infoBody.replaceChildren();
  infoBody.scrollTop = 0;
  infoModal.hidden = false;
  helpModal.hidden = true;
  updateHud();
  return infoBody;
}
function closeInfo() { infoModal.hidden = true; potionWindow = null; restoreSettingsButtons(); }
document.getElementById('infoClose').addEventListener('click', closeInfo);
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !infoModal.hidden) closeInfo(); });

const TITLE_INFO = {
  'Campeão do Pique-Pega': 'Termine o pique-pega com o menor tempo como pegador (/pique iniciar).',
  'Cumprimentador': 'Cumprimente amigos 5 vezes (tecla H, os dois precisam apertar).',
  'Dançarino': 'Dance por 90 segundos no total (tecla G).',
};
const TITLE_NAMES = Object.keys(TITLE_INFO);

function playersByMap() {
  const n = { village: 0, forest: 0, arena: 0 };
  n[currentMap]++; // você
  for (const r of Object.values(remotePlayers)) n[r.map || 'village']++;
  return n;
}

// ----- Menu (grade de botões) -----
function showMenu() {
  const body = openScreen('Menu', 'grid');
  const grid = uiEl('div', undefined, 'menuGrid');
  const tiles = [
    { label: 'Perfil', icon: 'profile', run: showProfile },
    { label: 'Classificação', icon: 'podium', run: showRanking },
    { label: 'Conquistas', icon: 'trophy', run: showAchievements },
    { label: 'Mapa', icon: 'map', run: showMapWindow },
    { label: 'Cidade', icon: 'castle', run: goHome },
    { label: 'Ajuda', icon: 'help', run: () => { closeInfo(); helpModal.hidden = false; } },
    { label: 'Configurações', icon: 'gear', run: showSettings },
    { label: 'Inventário', icon: 'bag', run: showInventory },
    { label: 'Loja', icon: 'shop', run: showShop },
    { label: 'Missões', icon: 'scroll', soon: true },
    { label: 'Sair', icon: 'exit', run: () => { if (sessionToken) clearAccount(); location.reload(); } }, // sai da conta (se houver) e volta à tela inicial
  ];
  for (const t of tiles) {
    const b = uiEl('button', undefined, 'tile' + (t.soon ? ' disabled' : ''));
    b.append(iconSvg(t.icon), uiEl('span', t.label));
    if (t.soon) { b.title = 'Em breve'; b.disabled = true; } else b.addEventListener('click', t.run);
    grid.append(b);
  }
  body.append(grid);
}
document.getElementById('menuBtn').addEventListener('click', () => { if (infoModal.hidden) showMenu(); else closeInfo(); });

// ----- Perfil (estilo ficha do personagem) -----
function showProfile() {
  const body = openScreen('Perfil', 'profile');
  const wrap = uiEl('div', undefined, 'winCols');
  const card = uiEl('div', undefined, 'charCard');
  const doll = document.createElement('canvas'); doll.width = 192; doll.height = 240; doll.className = 'bigDoll';
  drawPortrait(doll, myCharacter, false);
  const pts = totalPoints(), lv = levelInfo(pts);
  const who = uiEl('div', undefined, 'charName'); who.append(uiEl('div', accountInfo?.name || accountName || myName, 'n'), uiEl('div', localInfo.title || 'Sem título equipado', 's'));
  const lvl = uiEl('div', undefined, 'lvlRow'); lvl.append(uiEl('span', 'Nível ' + lv.level), uiEl('span', `${pts} / ${lv.to}`));
  const bar = uiEl('div', undefined, 'bar xp'); const fill = uiEl('i'); fill.style.width = lv.pct * 100 + '%'; bar.append(fill);
  const stats = uiEl('div', undefined, 'statList');
  card.append(who, doll, lvl, bar, stats);
  const right = uiEl('div', undefined, 'rightCol');
  const note = uiEl('p', undefined, 'note');
  right.append(uiEl('h3', 'Títulos', 'sec'));
  const slots = uiEl('div', undefined, 'slotGrid'); right.append(slots);
  const btns = uiEl('div', undefined, 'winBtns');
  for (const [label, fn] of [['Classificação', showRanking], ['Conquistas', showAchievements], ['Configurações', showSettings]]) {
    const b = uiEl('button', label, 'wide'); b.addEventListener('click', fn); btns.append(b);
  }
  right.append(note, btns);
  wrap.append(card, right); body.append(wrap);

  const fillTitles = earned => {
    for (const t of TITLE_NAMES) {
      const has = earned.includes(t), on = localInfo.title === t;
      const s = uiEl('button', undefined, 'slot' + (has ? '' : ' locked') + (on ? ' on' : ''));
      s.append(iconSvg(has ? 'trophy' : 'lock'), uiEl('span', t));
      s.title = has ? (on ? 'Clique para desequipar' : 'Clique para equipar') : TITLE_INFO[t];
      if (has) s.addEventListener('click', () => { equipTitle(on ? null : t); showProfile(); });
      slots.append(s);
    }
  };
  const addStat = (label, v) => { const r = uiEl('div'); r.append(uiEl('span', label), uiEl('b', String(v))); stats.append(r); };
  if (!sessionToken) {
    addStat('🪙 Moedas (só nesta sessão)', sessionCoins); addStat('🟢 Slimes derrotados', '—'); addStat('⚔️ Jogadores derrotados', '—'); addStat('💀 Derrotas', '—');
    fillTitles(getTitles());
    note.textContent = 'Você está jogando sem conta: nada é salvo. Entre com o Google na tela inicial para guardar pontos, títulos e a cor do nome, e aparecer na Classificação.';
    return;
  }
  connection.invoke('GetMyStats').then(r => {
    if (!r?.ok) { note.textContent = r?.reason || 'Não consegui ler o perfil agora.'; fillTitles(getTitles()); return; }
    addStat('🪙 Moedas', r.coins ?? totalCoins()); addStat('🟢 Slimes derrotados', r.slimeKills); addStat('⚔️ Jogadores derrotados', r.playerKills); addStat('💀 Derrotas', r.deaths);
    fillTitles([...new Set([...getTitles(), ...r.titles])]);
    note.textContent = 'Seu progresso é salvo automaticamente nesta conta.';
  }).catch(() => { note.textContent = 'O servidor ainda não tem o perfil (ele pode estar atualizando).'; fillTitles(getTitles()); });
}

// ----- Classificação -----
function showRanking() {
  const body = openScreen('Classificação', 'podium');
  const box = uiEl('div', undefined, 'listBox');
  body.append(box);
  box.append(uiEl('p', 'Carregando...', 'note'));
  connection.invoke('GetRanking').then(r => {
    box.replaceChildren();
    if (!r?.ok) { box.append(uiEl('p', r?.reason || 'Não consegui ler o ranking agora.', 'note')); return; }
    if (!r.rows.length) { box.append(uiEl('p', 'Ainda ninguém pontuou no combate. Vá à arena ou à floresta!', 'note')); return; }
    const head = uiEl('div', undefined, 'rankRow head');
    ['#', 'Jogador', 'Pontos', 'Slimes', 'Jogadores'].forEach((t, i) => head.append(uiEl('span', t, i > 1 ? 'num' : '')));
    box.append(head);
    const medals = ['🥇', '🥈', '🥉'];
    r.rows.forEach((x, i) => {
      const row = uiEl('div', undefined, 'rankRow' + (x.me ? ' me' : ''));
      row.append(uiEl('span', medals[i] || String(i + 1)), uiEl('span', x.name), uiEl('span', String(x.points), 'num'), uiEl('span', String(x.slimeKills), 'num'), uiEl('span', String(x.playerKills), 'num'));
      box.append(row);
    });
    box.append(uiEl('p', 'Pontos: +1 por golpe que acerta, +10 por jogador derrotado e +5 × o tamanho por slime derrotado. Só aparece quem entrou com o Google.', 'note'));
  }).catch(() => { box.replaceChildren(uiEl('p', 'O servidor ainda não tem a classificação (ele pode estar atualizando). Tente de novo em alguns minutos.', 'note')); });
}

// ----- Conquistas (títulos) -----
function showAchievements() {
  const body = openScreen('Conquistas', 'trophy');
  const box = uiEl('div', undefined, 'listBox');
  const earned = getTitles();
  for (const t of TITLE_NAMES) {
    const has = earned.includes(t), on = localInfo.title === t;
    const row = uiEl('div', undefined, 'achRow' + (has ? '' : ' locked') + (on ? ' on' : ''));
    const txt = uiEl('div'); txt.append(uiEl('b', t), uiEl('span', TITLE_INFO[t]));
    row.append(iconSvg(has ? 'trophy' : 'lock'), txt);
    if (has) { const b = uiEl('button', on ? 'Equipado ✔' : 'Equipar'); b.addEventListener('click', () => { equipTitle(on ? null : t); showAchievements(); }); row.append(b); }
    else row.append(uiEl('em', 'Bloqueado'));
    box.append(row);
  }
  box.append(uiEl('p', 'Mais conquistas virão. Os títulos aparecem ao lado do seu nome para todos.', 'note'));
  body.append(box);
}

// ----- Mapa -----
function showMapWindow() {
  const body = openScreen('Mapa', 'map');
  const counts = playersByMap();
  const box = uiEl('div', undefined, 'mapCards');
  for (const [key, name, desc, img] of [
    ['forest', 'Floresta', 'Grande e cheia de slimes. A música é heroica. Entre pela esquerda do vilarejo.', 'assets/fundo_floresta.jpg'],
    ['village', 'Vilarejo', 'O ponto de encontro: fonte, padaria, ferraria. Dá para dançar, conversar e jogar pique-pega.', 'assets/fundo_10h.jpg'],
    ['arena', 'Arena', 'Luta entre jogadores, com armas e ranking. Entre pela direita do vilarejo.', 'assets/fundo_arena.jpg'],
  ]) {
    const card = uiEl('div', undefined, 'mapCard' + (currentMap === key ? ' here' : ''));
    card.style.backgroundImage = `linear-gradient(#0000, #000b), url(${img})`;
    const info = uiEl('div'); info.append(uiEl('b', name), uiEl('span', desc), uiEl('em', `${counts[key]} jogador${counts[key] === 1 ? '' : 'es'}${currentMap === key ? ' · você está aqui' : ''}`));
    card.append(info); box.append(card);
  }
  body.append(box);
}

// ----- Cidade (voltar ao vilarejo) -----
function goHome() {
  closeInfo();
  connection.invoke('GoHome').then(r => { if (r && !r.ok) say([r.reason || 'Não foi possível voltar agora.']); })
    .catch(() => say(['Essa função ainda não está no servidor (ele pode estar atualizando). Tente de novo em alguns minutos.']));
}

// ----- Configurações -----
function showSettings() {
  const body = openScreen('Configurações', 'gear');
  const box = uiEl('div', undefined, 'listBox');
  const row = (label, control) => { const r = uiEl('div', undefined, 'setRow'); r.append(uiEl('span', label), control); box.append(r); };
  row('Música', document.getElementById('muteBtn'));
  row('Efeitos sonoros', document.getElementById('sfxBtn'));
  const fs = uiEl('button', '⛶ Tela cheia', 'pill'); fs.addEventListener('click', toggleFullscreen); row('Tela cheia', fs);
  if (sessionToken) { const out = uiEl('button', 'Sair da conta', 'pill'); out.addEventListener('click', () => { clearAccount(); location.reload(); }); row('Conta Google', out); }
  box.append(uiEl('p', 'O chat de voz (🎧) e o microfone (🎤) ficam na barra de ícones do topo.', 'note'));
  body.append(box);
}

// ---------- Poções: loja, inventário e botão rápido ----------
// Compra na Loja (moedas) → fica na mochila → Inventário → "Ativar" põe a poção no botão rápido ao lado do ataque (ou tecla F).
// O servidor decide preços, quantidades e a cura de vida; mana e stamina são aplicadas aqui quando o servidor confirma o uso.
const POTION_COLORS = { life: ['#ff6b5e', '#b3261e'], mana: ['#6bb6ff', '#1f5fb8'], stamina: ['#8be37f', '#2b8a3a'] };
const POTION_NAMES = { life: 'Poção de Vida', mana: 'Poção de Mana', stamina: 'Poção de Stamina' };
const POTION_DESCRIPTIONS = { life: 'Recupera 40 de vida (arena e floresta).', mana: 'Recupera 50 de mana.', stamina: 'Recupera 60 de stamina.' };

function potionIcon(kind, cls = '') {
  const [light, dark] = POTION_COLORS[kind] || ['#ccc', '#777'];
  const d = document.createElement('span');
  d.className = 'ico potion ' + cls;
  d.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2.5h6v2h-1V8l4.7 8.6A3 3 0 0 1 16.1 21H7.9a3 3 0 0 1-2.6-4.4L10 8V4.5H9z" fill="#dfe8f5" fill-opacity=".28" stroke="#dfe8f5" stroke-width="1.2"/><path d="M7.2 15.4L10 10h4l2.8 5.4A1.6 1.6 0 0 1 15.4 18H8.6a1.6 1.6 0 0 1-1.4-2.6z" fill="${dark}"/><path d="M8 15.8l2.2-4.4h3.6L16 15.8z" fill="${light}"/><rect x="8.6" y="1.2" width="6.8" height="2" rx=".8" fill="#9b7a4b"/></svg>`;
  return d;
}

const ownedItems = () => accountInfo?.items || (accountInfo ? (accountInfo.items = {}) : {});
const activePotion = () => accountInfo?.activePotion || null;
let lastPotionAt = 0;

// botão rápido (celular: ao lado do ataque; computador: círculo no canto inferior direito, como nas skills do jogo de referência)
const potionBtns = [document.getElementById('potionBtn'), document.getElementById('potionBtnDesk')];
function renderPotionButtons() {
  const kind = activePotion(), qty = kind ? (ownedItems()[kind] || 0) : 0;
  for (const b of potionBtns) {
    if (!b) continue;
    b.replaceChildren();
    b.classList.toggle('empty', !kind);
    if (kind) { b.append(potionIcon(kind), uiEl('span', String(qty), 'badge')); b.title = `${POTION_NAMES[kind]} (tecla F) — restam ${qty}`; }
    else { b.append(uiEl('span', '＋', 'plus')); b.title = 'Nenhuma poção ativada: abra o Inventário (menu) e escolha Ativar'; }
  }
}
potionBtns.forEach(b => b?.addEventListener('pointerdown', e => { e.preventDefault(); usePotion(); }));
potionBtns.forEach(b => b?.addEventListener('contextmenu', e => e.preventDefault()));

async function usePotion() {
  const now = Date.now();
  if (now - lastPotionAt < 1500) return;
  if (!sessionToken) { say(['Entre com o Google na tela inicial para comprar e usar poções.']); return; }
  const kind = activePotion();
  if (!kind) { showInventory(); return; } // nada ativado: leva para a mochila
  if (kind === 'mana' && manaNow() >= MANA_MAX - 1) { say(['Sua mana já está cheia.']); return; }
  if (kind === 'stamina' && staminaNow() >= STAMINA_MAX - 1) { say(['Sua stamina já está cheia.']); return; }
  lastPotionAt = now;
  try {
    const r = await connection.invoke('UsePotion');
    if (!r?.ok) { say([r?.reason || 'Não foi possível usar a poção.']); if (r?.qty === 0) { ownedItems()[kind] = 0; accountInfo.activePotion = null; renderPotionButtons(); } return; }
    ownedItems()[kind] = r.qty;
    if (r.qty <= 0) accountInfo.activePotion = null;
    if (r.resource === 'mana') { manaNow(); manaValue = Math.min(MANA_MAX, manaValue + r.amount); }
    if (r.resource === 'stamina') { staminaNow(); staminaValue = Math.min(STAMINA_MAX, staminaValue + r.amount); }
    renderPotionButtons();
    potionFx(r.resource, r.amount);
    if (r.qty <= 0) say([`Acabaram as ${POTION_NAMES[kind]}s. Compre mais na Loja.`]);
    if (!infoModal.hidden) refreshOpenPotionWindow();
  } catch { say(['Essa função ainda não está no servidor (ele pode estar atualizando). Tente de novo em alguns minutos.']); }
}
function potionFx(resource, amount) {
  const sprite = localSprite; if (!sprite || !gameScene) return;
  const color = { life: '#ff8a80', mana: '#82c8ff', stamina: '#a5f09a' }[resource] || '#fff';
  const label = { life: '❤', mana: '💧', stamina: '⚡' }[resource] || '';
  const t = gameScene.add.text(sprite.x, sprite.y - 60, `+${amount} ${label}`, { fontSize: '18px', fontStyle: 'bold', color, stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(9);
  gameScene.tweens.add({ targets: t, y: t.y - 36, alpha: 0, duration: 900, ease: 'Quad.Out', onComplete: () => t.destroy() });
  chip([523, 659, 784, 1047], 0.04, 'triangle', 0.1);
}
window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'f' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || !chatReady || !chatBar.hidden || !helpModal.hidden || !infoModal.hidden) return;
  usePotion();
});

let potionWindow = null; // 'shop' | 'inventory' enquanto aberta (para atualizar depois de usar poção)
const refreshOpenPotionWindow = () => { if (potionWindow === 'inventory') showInventory(selectedItem); else if (potionWindow === 'shop') showShop(); };

// ----- Loja -----
async function showShop() {
  const body = openScreen('Loja', 'shop');
  potionWindow = 'shop';
  const box = uiEl('div', undefined, 'listBox');
  body.append(box);
  if (!sessionToken) { box.append(uiEl('p', 'Entre com o Google na tela inicial para comprar. As moedas e o que você compra ficam salvos na sua conta.', 'note')); return; }
  box.append(uiEl('p', 'Carregando...', 'note'));
  let shop;
  try { shop = await connection.invoke('GetShop'); } catch { box.replaceChildren(uiEl('p', 'A loja ainda não está no servidor (ele pode estar atualizando). Tente de novo em alguns minutos.', 'note')); return; }
  box.replaceChildren();
  const msg = uiEl('p', 'Você ganha moedas derrotando slimes na floresta.', 'note');
  for (const it of shop.items) {
    const row = uiEl('div', undefined, 'shopRow');
    const txt = uiEl('div'); txt.append(uiEl('b', it.name), uiEl('span', it.description), uiEl('em', `Você tem: ${ownedItems()[it.id] || 0}`));
    const price = uiEl('div', undefined, 'price'); price.append(uiEl('span', `🪙 ${it.price}`));
    const buy = uiEl('button', 'Comprar'); buy.disabled = totalCoins() < it.price;
    buy.addEventListener('click', async () => {
      buy.disabled = true;
      try {
        const r = await connection.invoke('BuyItem', it.id);
        if (!r?.ok) { msg.textContent = r?.reason || 'Não foi possível comprar.'; msg.className = 'note bad'; }
        else {
          accountInfo.stats = { ...(accountInfo.stats || {}), coins: r.coins }; sessionCoins = 0; // o servidor manda o total certo
          ownedItems()[r.item] = r.qty; renderPotionButtons();
          msg.textContent = `✔ Você comprou 1 ${it.name}. Vá ao Inventário e escolha Ativar para colocá-la no botão rápido.`; msg.className = 'note good';
          updateHud();
        }
      } catch { msg.textContent = 'A compra não está disponível agora. Tente de novo em alguns minutos.'; msg.className = 'note bad'; }
      refreshRows();
    });
    price.append(buy);
    row.append(potionIcon(it.id, 'big'), txt, price);
    row.dataset.price = it.price; row.dataset.kind = it.id; row._buy = buy;
    box.append(row);
  }
  box.append(msg);
  function refreshRows() { // moedas e quantidades novas depois de uma compra
    for (const r of box.querySelectorAll('.shopRow')) {
      r._buy.disabled = totalCoins() < Number(r.dataset.price);
      r.querySelector('em').textContent = `Você tem: ${ownedItems()[r.dataset.kind] || 0}`;
    }
  }
}

// ----- Inventário (mochila) -----
let selectedItem = null;
function showInventory(select) {
  const body = openScreen('Inventário', 'bag');
  potionWindow = 'inventory';
  if (typeof select === 'string') selectedItem = select;
  const wrap = uiEl('div', undefined, 'invWrap');
  body.append(wrap);
  if (!sessionToken) { wrap.append(uiEl('p', 'Entre com o Google na tela inicial para ter uma mochila. Os itens ficam salvos na sua conta.', 'note')); return; }
  const owned = Object.entries(ownedItems()).filter(([, q]) => q > 0);
  const grid = uiEl('div', undefined, 'invGrid');
  const detail = uiEl('div', undefined, 'invDetail');
  if (!owned.length) {
    wrap.append(uiEl('p', 'Sua mochila está vazia. Derrote slimes para ganhar moedas e compre poções na Loja.', 'note'));
    const go = uiEl('button', 'Ir para a Loja', 'wide'); go.addEventListener('click', showShop); wrap.append(go);
    return;
  }
  if (!selectedItem || !(ownedItems()[selectedItem] > 0)) selectedItem = owned[0][0];
  for (const [kind, qty] of owned) {
    const slot = uiEl('button', undefined, 'invSlot' + (kind === selectedItem ? ' sel' : '') + (kind === activePotion() ? ' active' : ''));
    slot.append(potionIcon(kind), uiEl('span', String(qty), 'badge'));
    if (kind === activePotion()) slot.append(uiEl('span', 'ATIVA', 'tag'));
    slot.title = POTION_NAMES[kind];
    slot.addEventListener('click', () => { selectedItem = kind; showInventory(); });
    grid.append(slot);
  }
  const kind = selectedItem, isActive = kind === activePotion();
  detail.append(potionIcon(kind, 'huge'), uiEl('h3', POTION_NAMES[kind]), uiEl('p', POTION_DESCRIPTIONS[kind], 'desc'), uiEl('p', `Quantidade: ${ownedItems()[kind]}`, 'qtyLine'));
  const status = uiEl('p', isActive ? '✔ Esta poção está no botão rápido (tecla F).' : 'Ative para colocá-la no botão ao lado do ataque.', 'note');
  const act = uiEl('button', isActive ? 'Desativar' : 'Ativar', 'wide' + (isActive ? '' : ' primary'));
  act.addEventListener('click', async () => {
    act.disabled = true;
    try {
      const r = await connection.invoke('SetActivePotion', isActive ? null : kind);
      if (r?.ok) { accountInfo.activePotion = r.active; renderPotionButtons(); showInventory(); }
      else { status.textContent = r?.reason || 'Não foi possível ativar.'; status.className = 'note bad'; act.disabled = false; }
    } catch { status.textContent = 'Essa função ainda não está no servidor. Tente de novo em alguns minutos.'; status.className = 'note bad'; act.disabled = false; }
  });
  detail.append(act, status);
  wrap.append(grid, detail);
}

// ---------- Inicialização (depois de entrar no jogo) ----------
function setupUi() {
  ui.hud.hidden = false;
  drawPortrait(ui.face, myCharacter);
  if (potionBtns[1]) potionBtns[1].hidden = coarsePointer; // no celular o botão da poção fica ao lado do ataque (#potionBtn)
  renderPotionButtons();
  setInterval(updateHud, 400);
}
