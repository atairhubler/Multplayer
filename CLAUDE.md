# Jogo de plataforma multiplayer (PoC → "praça virtual" para amigos)

Jogo 2D no navegador, em tempo real, para o dono do projeto e os amigos passarem o tempo juntos.
Cenário: um vilarejo medieval em pixel art (3 imagens de fundo por horário). Os personagens andam na calçada
de pedra na borda inferior, conversam por chat/voz, fazem ações sociais, jogam pique-pega e compartilham a tela.
**Idioma do projeto e do usuário: português do Brasil** (UI, mensagens, comentários, respostas).

## Onde roda (tudo gratuito)
| Parte | Onde | Como publica |
|---|---|---|
| Front (`Server/wwwroot`) | GitHub Pages: https://atairhubler.github.io/Multplayer/ | `.github/workflows/pages.yml` publica `Server/wwwroot` a cada push na `main` (~1 min). A fonte do Pages é "GitHub Actions". |
| Back (ASP.NET Core + SignalR) | Render free: https://plataforma-multiplayer.onrender.com | Docker (`Server/Dockerfile`, `render.yaml`), deploy automático a cada push (alguns min). Variável `ALLOWED_ORIGINS=https://atairhubler.github.io`. |

- Repositório: https://github.com/atairhubler/Multplayer (remote HTTPS; SSH não funcionou). Trabalha-se direto na `main`.
- O Render free **dorme após ~15 min** sem tráfego (1ª conexão leva 30–60 s). `/health` serve para ping de keep-alive (UptimeRobot etc., opcional).
- **Atenção ao deploy:** o front atualiza antes do back. O cliente novo pode chamar métodos que o servidor antigo ainda não tem.
  Por isso chamadas opcionais usam `.catch(() => {})` (ex.: `UpdateProfile`). Mantenha esse cuidado ao adicionar métodos novos.
- No PC do dono: `cd Server && dotnet run` → http://localhost:5000 (a porta vem de `PORT`; o servidor também serve o front de `wwwroot`).
  O projeto mira `net8.0` com `RollForward=Major` (a máquina só tem o SDK 10).

## Estrutura
```
Server/
  Program.cs        Minimal API: CORS (ALLOWED_ORIGINS), estáticos, /health, /avatars (upload de GIF), hub em /gamehub
  GameHub.cs        Hub SignalR (jogadores, chat, emotes, ações sociais, voz, compartilhar tela). Estado 100% em memória.
  TagGame.cs        Pique-pega (loop de 100 ms no servidor)
  ArenaGame.cs      Arena PvP (mapa separado): vida, armas, dano/alcance/recarga, flechas, pontos, ranking, respawn (loop de 50 ms)
  AvatarStore.cs    GIFs animados enviados por upload (memória, 3 MB cada, 150 MB total, somem ao desconectar)
  Player.cs         Modelo do jogador (Id, Name, CharacterSprite, X, Y, NameColor, Title, Dancing, RidingOn, Sharing)
  wwwroot/
    index.html      Login (nome, gênero, cores, upload de imagem), chat, painel de online, HUD, bandeja de emotes, projeções
    game.js         TODO o cliente (Phaser 3 + SignalR + WebRTC). ~1.5k linhas, seções comentadas (veja abaixo)
    assets/         peças do boneco (+ dolls.json), fundos (fundo_10h/15h/18h.jpg), projecao.png/json
tools/              build-doll-assets.js, build-projection-asset.js e build-arena-assets.js (fundo da arena, placa, balão) (geram os assets a partir de /Personagens; precisam de `npm i pngjs`)
Personagens/        arte-fonte enviada pelo dono (Homem/, Mulher/, background/, Compartilhar/). Não é usada em runtime.
```

## Visão geral do cliente (`game.js`, por seções)
- **Constantes:** mundo fixo 1280×600 (`WORLD_W`, `VIEW_H`), escala FIT (o mapa inteiro sempre aparece). Personagem 32×48 × `CHAR_SCALE` 1.4 (`CHAR_W/CHAR_H`).
  Chão invisível com os pés em `GROUND_TOP = 594` (calçada do fundo). **Não há plataformas.**
- **Login/perfil:** nome, gênero, cores de cabelo/pele/roupa/nome, upload de imagem. Perfil salvo em `localStorage('profile')`; títulos em `titles`/`title`; música muda em `muted`.
- **Personagem (`CharacterSprite`, string):** `char:m|f:HHHHHH:SSSSSS:CCCCCC` (boneco), `data:image/...` (imagem estática ≤ 40 mil chars), `/avatars/<guid>` (GIF animado via upload).
  O boneco é montado com peças PNG (assets/m_*.png, f_*.png + `dolls.json` com pivôs) **recoloridas por zona de cor** (pele=laranja, cabelo=azul, roupa=verde → cor escolhida, mantendo o sombreado). Animação por rotação de braços/pernas (andar, pular, parado, dançar).
- **Fundo por horário (relógio local do jogador):** 10h–14h59 → fundo 10h; 15h–17h59 → 15h; 18h–9h59 → 18h.
- **Chat estilo MMORPG:** canto inferior esquerdo, transparente, rolável, **dentro do canvas** (posicionado com `positionChat()`; no celular vai para o topo). Enter abre a caixa; Enter envia; Esc cancela. Mensagens que começam com `/` são comandos (`runCommand`). Sempre usar `textContent` (nunca `innerHTML`) para texto de usuários.
- **Controles:** setas (e botões de toque no celular), emotes 1–6, **H** cumprimentar, **Q** empurrar, **R** subir/descer das costas, **G** dançar (também funciona em cima de alguém, na torre), **E** interagir. No celular a bandeja 😀 reúne as ações. Modo paisagem obrigatório no celular (aviso + tela cheia/lock onde o navegador deixa).
- **Ajuda (?):** botão no canto inferior direito abre uma janela com grupos expansíveis (`HELP_GROUPS`, reaproveita o objeto `HELP`). **Dica de movimento** no centro ao entrar (some ao andar).
- **Avisos do sistema** no chat (entrou, bebeu água...) somem em ~3 s (`addChatLine(null, texto, true)`); respostas de comandos (`say`) ficam. Mensagem de outro jogador toca `playPing()`.
- **Torre:** dá para subir no topo de quem já carrega alguém, até 10 empilhados (`MaxTower` no servidor, `TOWER_MAX`/`chainDepth` no cliente).
- **Pique-pega:** o pegador pisca todo em vermelho (`updateTagFlash`, boneco/imagem/GIF).
- **Mapas:** `Player.Map` = `village` | `arena`. Segurar → no fim da rua (x ≥ ~1254) por 0,4 s leva à arena; segurar ← no começo da arena volta (`ChangeMap`). Fora do próprio mapa os jogadores ficam invisíveis (`syncVisibility`); ações sociais/pique só no mesmo mapa. Placa pequena (`placa_arena.png`) no vilarejo em x≈1135.
- **Arena:** Espaço/X ataca, teclas 1–5 trocam de arma (Espada, Lança, Arco, Martelo, Garras; números no `Weapons` do servidor, mesma ordem do cliente), vida 100, +1 ponto por golpe e +10 por abate, respawn em 3 s com 2 s de imunidade. Ranking no canto superior esquerdo, vida/armas no topo ao centro; o botão ? mostra só a ajuda da arena enquanto se está nela. Efeitos e sons 16 bits desenhados/sintetizados por código (`swingFx`, `hitFx`, `sfxAttack`, `sfxHurt`...). Os efeitos seguem o botão 🔊/🔕 (a música tem o seu, 🎵/🔇).
- **Dash:** dois toques rápidos na seta (≤250 ms), vale no ar; recarga 500 ms (`handleDash`).
- **Balão de chat:** pergaminho (`assets/balao.png` + `balao.json`) em 3 partes, gerado por `tools/build-arena-assets.js`.
- **Música ambiente:** gerada por WebAudio (sem arquivos), muda com o período do dia; enquanto alguém dança entra uma batida alegre (`setDanceMusic`) e a ambiente abaixa; `MUSIC_VOLUME` = 0.125; botão 🎵 muta só a música e o botão 🔊 só os efeitos (`music.muted` e `music.sfxMuted`, salvos em `localStorage` `muted`/`sfxMuted`).
- **Social:** títulos (Campeão do Pique-Pega, Cumprimentador, Dançarino) guardados no navegador; cor do nome; lista de online; aviso sonoro quando alguém entra.
- **Chat de voz (WebRTC em malha):** botões 🎧 (entrar/sair) e 🎤 (mutar). Servidores ICE vêm de `GET /ice-servers` (STUN + TURN; credenciais próprias via variáveis `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` no Render, senão usa o relay público Open Relay da Metered); fallback local `VOICE_ICE_SERVERS` (só STUN). Quem entra liga para quem já estava. Sinais por par são serializados, há tratamento de ofertas cruzadas e reinício de ICE; estados aparecem no console (`[voz]`). Volume cai com a distância; 🎙️ no nome de quem fala.
- **Projeção (`/compartilhar`):** `getDisplayMedia` → moldura arcana (`assets/projecao.png`) sobre a cabeça. Os outros veem a moldura vazia e só assistem ao chegar perto e interagir (E/toque); de novo, ou clique, amplia ("teatro"). Sai da faixa de 720 px → para de receber. Só computador compartilha.

## Protocolo SignalR (resumo)
Cliente → servidor: `JoinGame(name, character)`, `UpdateProfile(nameColor, title)`, `UpdatePosition(x,y)`, `SendMessage`, `Emote(0–5)`,
`Greet`, `Push`, `ToggleRide`, `SetDancing(bool)`, `Interact(spot)`, `StartTag`, `StopTag`, `JoinVoice`, `LeaveVoice`, `VoiceSignal(to, json)`,
`StartShare`, `StopShare`, `ShareSignal(to, json)`, `ChangeMap(map)`, `SetWeapon(i)`, `Attack(dir)`, `Dash(dir)`.
Servidor → cliente: `ExistingPlayers`, `PlayerJoined`, `PlayerMoved`, `PlayerLeft`, `PlayerProfile`, `ChatHistory`, `ChatMessage`, `SystemMessage` (aceita `\n`),
`PlayerEmote(id, n)`, `Pushed(dir)`, `Riding(id, carrierId|null, x, y)`, `PlayerDance`, `TagState`, `TitleEarned`, `VoiceMembers`, `VoiceRoster`, `VoiceState`, `VoiceSignal`, `ShareState`, `ShareSignal`, `PlayerMap(id, map, x, y)`, `ArenaState(lista)`, `ArenaSwing`, `ArrowFired`, `ArenaHit`, `ArenaKill`, `PlayerDash`.
**Atenção:** no servidor, para enviar vários argumentos montados num array use `SendCoreAsync(método, args)` (o `SendAsync(método, object[])` embrulha o array num único argumento).
IDs de emote: 0–5 teclado; 6🖐️ 7🤝 8💢 9🎵; 20–26 pontos do vilarejo (a ordem de `SPOTS` no cliente e `Spots` no servidor **deve coincidir**).

## Regras/decisões importantes
- O servidor valida tudo que vem do cliente (regex do boneco, data URL, cores, títulos permitidos, limites de tamanho e de frequência). Mantenha isso em novos recursos.
- **Sem banco de dados** de propósito (por enquanto): tudo some ao reiniciar. O dono pretende adicionar um banco só quando quiser algo permanente (contas/login Google, chat com histórico, inventário).
- Títulos vivem só no `localStorage` (dá para forjar; aceito, é para amigos).
- Pontos do vilarejo (`SPOTS` em game.js): x estimados sobre as imagens de fundo (fonte 798, padaria 1220, ferraria 1041, barracas 335/486/598, porta 122). Se algo parecer deslocado, ajustar aí.
- Texto do usuário nunca vira HTML. Pronomes: não gendrar quem não se sabe (usar "o jogador", "um amigo").

## Como testar (dicas que funcionaram)
- Navegador de teste (extensão Chrome): a aba fica **oculta**, então `requestAnimationFrame` é limitado. Use `phaserGame.step(t, 16.7)` em loop para avançar o jogo e passe `t` espaçado (~60 ms) para o throttle de envio de posição. Cliques sintéticos não contam como gesto do usuário (autoplay/áudio/`getUserMedia` real não funcionam) → simule `navigator.mediaDevices.getUserMedia/getDisplayMedia` com `AudioContext`/`canvas.captureStream()`.
- Para 2 jogadores: duas abas, ou uma segunda conexão `new signalR.HubConnectionBuilder().withUrl(SERVER_URL + '/gamehub')` na mesma página.
- Rodar o servidor local em outra porta (`PORT=508x dotnet run --no-build`) e **matar pelo PID da porta** ao terminar (`netstat -ano | grep :508x`).
- Scripts de edição longos: heredocs grandes no Bash falharam várias vezes; escrever o script com a ferramenta Write num arquivo temporário e rodar com `node` funcionou.
- O repositório avisa "LF will be replaced by CRLF" ao commitar: é inofensivo.
- Commits terminam com a linha `Co-Authored-By: Claude ...` (padrão da sessão).

## Preferências do dono
- Quer o resultado funcionando e publicado (push), explicado de forma simples e curta, em pt-BR.
- Quando diz "só curiosidade"/"não modifica nada", **só responder**, sem alterar arquivos.
- Gosta de ir adicionando recursos aos poucos; confirma o visual no navegador e pede ajustes finos (tamanhos, volumes, posições).
- Arte: o dono gera as imagens (Leonardo.ai etc.) e coloca em `Personagens/`; o código só consome o que está em `Server/wwwroot/assets` (gerado pelos scripts em `tools/`).

## Ideias ainda não feitas
- Mais salas/mapas com portas; interagir com mais objetos do cenário (bancos, tochas à noite); mais minijogos (esconde-esconde, corrida, moedas).
- Salas privadas com código e moderação (silenciar/expulsar); lista de quem assiste à projeção; TV fixa no cenário; controle de quem pode compartilhar.
- Servidor TURN (se algum amigo não conseguir voz/tela em dados móveis); servidor de mídia (SFU) se o grupo crescer além de ~6 pessoas.
- Chapéus/acessórios; título por conquistas novas; persistência (banco) e login com Google.
- Keep-alive do Render (monitor em `/health`).

## Pendências conhecidas / não verificado em ambiente real
- Voz e compartilhamento foram testados só com mídia sintética (conexão WebRTC e vídeo funcionaram entre duas abas); falta teste com microfone/tela reais, 3+ pessoas e celular/dados móveis.
- Bug relatado (voz): com 3 pessoas, B e C não se ouviam (A ouvia os dois). Em teste local com 3 abas as 3 conexões fecham; a causa provável é NAT sem relay; foi adicionado TURN (ainda não confirmado em rede real). Se continuar, pedir o log `[voz]` do console de B e C e configurar um TURN próprio no Render.
- Indicador 🎙️ (quem fala) não foi confirmado visualmente.
- Som (música, aviso de entrada) não foi ouvido nos testes automáticos.
