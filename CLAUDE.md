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
tools/              (a arte do homem é `Personagens/Homem/homem png partido 2.png`, a da mulher `Mulher/Mulher png partida.png`) build-doll-assets.js, build-projection-asset.js e build-arena-assets.js (fundo da arena, placa, balão) (geram os assets a partir de /Personagens; precisam de `npm i pngjs`)
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
- **Avisos do sistema** no chat (entrou, bebeu água...) somem em ~3 s (`addChatLine(null, texto, true)`); respostas de comandos (`say`) ficam. Mensagem de outro jogador toca `playPing()` (ding-dong, com reserva por `<audio>` WAV se o WebAudio estiver parado); a sua própria toca `playSend()` (blip curto).
- **Torre:** dá para subir no topo de quem já carrega alguém, até 10 empilhados (`MaxTower` no servidor, `TOWER_MAX`/`chainDepth` no cliente).
- **Pique-pega:** o pegador pisca todo em vermelho (`updateTagFlash`, boneco/imagem/GIF).
- **Mapas:** `Player.Map` = `village` | `forest` | `arena`. Ligados pelas bordas (faixa `MAP_EDGE_ZONE`, segurar a seta 0,4 s ou dar dash contra a borda): floresta ←(esquerda) vilarejo (direita)→ arena (`ChangeMap`; transições e posições de entrada em `GameHub.TryTransition`). Fora do próprio mapa os jogadores ficam invisíveis (`syncVisibility`); ações sociais/pique só no mesmo mapa. Placa pequena (`placa_arena.png`) no vilarejo em x≈1135.
- **Floresta grande:** 5.815 px de largura (~4,5 telas; `FOREST_W` no cliente = `ArenaGame.ForestW` no servidor — **mantenha os dois iguais**). Fundo = 5 faixas lado a lado (`FOREST_TILES` 1-2-3-2-1 de `fundo_floresta`, `_2`, `_3`, cada uma exibida com 1163×649 px: a imagem é mais alta que a tela para o chão cair em `GROUND_TOP`; as imagens 2 e 3 carregam sob demanda). A **câmera acompanha o jogador** (`updateCamera`, manual: `camX`, suavizada) e todos os overlays em HTML (GIFs, projeções) e os balões descontam `camX`; vilarejo/arena têm 1 tela (câmera parada). Chão e limites do mundo mudam por mapa em `applyMap` (`mapW()`, `groundRect`). Entra-se pelo fim **direito** (x = ForestW − 60) e sai-se pelo mesmo lado. Há ~22 slimes (≈5 por tela) e um **minimapa** (`#minimap`) no topo. Ao trocar as imagens da floresta, aumente `FOREST_ART_VERSION`.
- **Floresta (regras):** fundo `fundo_floresta.jpg`, placa `placa_floresta.png` no vilarejo (x≈225, aponta para a esquerda), música heroica (`setForestMusic`, ~92 bpm, Ré maior). Mapa de combate **cooperativo**: vida, armas 1–5 e ranking como na arena, mas jogadores **não se machucam**; só os slimes (5 verdes, 30 de vida, pulam atrás de quem está à vista, encostar tira 6 de vida a cada 1,5 s, abatê-los dá +5, voltam em 6 s). Quem cai na floresta volta para o vilarejo (x=640) após 3 s. **Evolução:** cada jogador que um slime derrota dobra o tamanho, a vida e o dano dele (1x, 2x, 4x, 8x e no máximo 10x) e muda a cor (verde, azul, amarelo, laranja, roxo com coroa); abater um slime vale 5 × o tamanho; ele fica evoluído mesmo que todos saiam da floresta (só some se o servidor reiniciar ou se ele for derrotado, aí volta 1x). Dano de contato base = 18 (×tamanho). Slimes não têm olhos nem boca (decisão do dono). Ações sociais (cumprimentar, dançar, subir nas costas) valem na floresta; só a arena as desliga. O servidor simula os slimes em `ArenaGame.cs` e envia `SlimeState` ~10×/s ao grupo `forest`.
- **Armas na mão:** os bonecos (`char:`) mostram a arma escolhida na mão da frente (`drawWeapon`, desenhada por código; `doll.setWeapon`/`doll.swingWeapon`), só nos mapas de combate. Imagens e GIFs não têm braço e não mostram a arma (só os efeitos de golpe).
- **Arena:** Espaço/X ataca, teclas 1–5 trocam de arma (Espada, Lança, Arco, Martelo, Garras; números no `Weapons` do servidor, mesma ordem do cliente), vida 100, +1 ponto por golpe e +10 por abate, respawn em 3 s com 2 s de imunidade. Ranking no canto superior esquerdo, vida/armas no topo ao centro; o botão ? mostra só a ajuda da arena enquanto se está nela. Efeitos e sons 16 bits desenhados/sintetizados por código (`swingFx`, `hitFx`, `sfxAttack`, `sfxHurt`...). Os efeitos seguem o botão 🔊/🔕 (a música tem o seu, 🎵/🔇).
- **Dash:** dois toques rápidos na seta (≤250 ms), vale no ar; recarga 500 ms (`handleDash`).
- **Balão de chat:** pergaminho (`assets/balao.png` + `balao.json`) em 3 partes, gerado por `tools/build-arena-assets.js`.
- **Música ambiente:** gerada por WebAudio (sem arquivos), muda com o período do dia; enquanto alguém dança (no mesmo mapa) entra uma batida alegre (`setDanceMusic`) e na arena toca uma música de batalha chiptune de ~152 bpm (`setBattleMusic`); em ambos a ambiente abaixa; `MUSIC_VOLUME` = 0.125; botão 🎵 muta só a música e o botão 🔊 só os efeitos (`music.muted` e `music.sfxMuted`, salvos em `localStorage` `muted`/`sfxMuted`).
- **Social:** títulos (Campeão do Pique-Pega, Cumprimentador, Dançarino) guardados no navegador; cor do nome; lista de online; aviso sonoro quando alguém entra.
- **Chat de voz (WebRTC em malha):** botões 🎧 (entrar/sair) e 🎤 (mutar). Servidores ICE vêm de `GET /ice-servers` (STUN + TURN; credenciais próprias via variáveis `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` no Render, senão usa o relay público Open Relay da Metered); fallback local `VOICE_ICE_SERVERS` (só STUN). Quem entra liga para quem já estava. Sinais por par são serializados, há tratamento de ofertas cruzadas e reinício de ICE; estados aparecem no console (`[voz]`). Volume cai com a distância; 🎙️ no nome de quem fala.
- **Projeção (`/compartilhar`):** `getDisplayMedia` → moldura arcana (`assets/projecao.png`) sobre a cabeça. Os outros veem a moldura vazia e só assistem ao chegar perto e interagir (E/toque); de novo, ou clique, amplia ("teatro"). Sai da faixa de 720 px → para de receber. Só computador compartilha.

## Protocolo SignalR (resumo)
Cliente → servidor: `JoinGame(name, character)`, `UpdateProfile(nameColor, title)`, `UpdatePosition(x,y)`, `SendMessage`, `Emote(0–5)`,
`Greet`, `Push`, `ToggleRide`, `SetDancing(bool)`, `Interact(spot)`, `StartTag`, `StopTag`, `JoinVoice`, `LeaveVoice`, `VoiceSignal(to, json)`,
`StartShare`, `StopShare`, `ShareSignal(to, json)`, `ChangeMap(map)`, `SetWeapon(i)`, `Attack(dir)`, `Dash(dir)`.
Servidor → cliente: `ExistingPlayers`, `PlayerJoined`, `PlayerMoved`, `PlayerLeft`, `PlayerProfile`, `ChatHistory`, `ChatMessage`, `SystemMessage` (aceita `\n`),
`PlayerEmote(id, n)`, `Pushed(dir)`, `Riding(id, carrierId|null, x, y)`, `PlayerDance`, `TagState`, `TitleEarned`, `VoiceMembers`, `VoiceRoster`, `VoiceState`, `VoiceSignal`, `ShareState`, `ShareSignal`, `PlayerMap(id, map, x, y)`, `ArenaState(lista, com `map`)`, `SlimeState(lista)`, `ArenaSwing`, `ArrowFired`, `ArenaHit`, `ArenaKill`, `PlayerDash`.
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

## Armadilhas já encontradas (não repetir)
- **Cache do GitHub Pages:** logo após um deploy o navegador pode misturar `index.html` antigo com `game.js` novo; elementos novos faltam, o script quebra no meio e o personagem "trava" até o F5. O início do `game.js` confere os ids obrigatórios (`need`) e recarrega uma vez; **ao criar elementos novos no HTML que o JS usa no carregamento, acrescente o id nessa lista**.
- **Limites no servidor:** `Allow()` (ações sociais) é compartilhado; o dash e a troca de mapa têm limites próprios (`LastDashAt`, `LastMapAt`). Nunca faça uma ação frequente (dash) consumir o limite de uma ação crítica (sair da arena).
- A saída/entrada da arena vale numa faixa de 56 px junto da borda (`MAP_EDGE_ZONE`) e também com um dash contra a borda.
- `safe()` envolve as rotinas secundárias do quadro (`update`) para um erro nelas não parar o movimento.

## Arte do boneco
- Homem: arte pixel art nova (`homem png partido 2.png`; `homem png 2.png` é só a referência para casar escala/posição, constantes em `GENDERS.m` de `tools/build-doll-assets.js`, que agora tem `figTop/figBot` por personagem). Mulher: arte antiga.
- A recoloração (`recoloredPart` no `game.js`) tem regras só para o homem: pele = matiz ≥ 24° e saturação ≥ 0,7 (o couro marrom de cinto/bolsa não vira pele), roupa aceita verdes mais apagados (saturação ≥ 0,22), cabelo escuro (luminosidade < 0,2) fica como contorno.
- **Ao trocar as imagens do boneco, aumente `DOLL_ART_VERSION` no `game.js`** (os arquivos `assets/m_*.png` mantêm o nome e o navegador guardaria a arte antiga).
- Celular: o movimento é um analógico virtual (`#stick`: lados andam, cima pula; o ▲ da direita também pula); botões de toque a 50% de opacidade (50% transparentes). ⛶ (tela cheia) fica acima de 💬 no celular e ao lado do ? no computador (`toggleFullscreen`). 💬 e 😀 ficam em coluna na lateral esquerda (acima das setas); 🗡️ (só na arena/floresta) fica ao lado do ▲, no mesmo tamanho.
- O jogo se ajusta à área visível (`fitGameToWindow`): usa `visualViewport`/`100dvh` e reajusta algumas vezes após `resize`, girar o aparelho e entrar/sair da tela cheia (antes o conteúdo ficava cortado ao sair da tela cheia).
- Os botões de toque ficam numa camada (`#touch`) que o JS faz coincidir com a área visível (`visualViewport`), com cada grupo preso a um canto (analógico à esquerda, coluna ⛶/💬/😀 ao lado dele, 🗡️ ataque + 💨 dash + ▲ pular à direita (nessa ordem); o 💨 dá dash para onde a bolinha aponta ou, parado, para onde o personagem olha); em telas baixas (`max-height: 430px`) tudo encolhe para nada ser cortado.

## Banco de dados (em implantação, passo a passo)
- **Postgres na Neon** (plano grátis permanente, região AWS US West 2/Oregon, igual ao Render). A conexão vem da variável `DATABASE_URL` (no Render: serviço → Environment); **nunca** colocar a senha no código nem no chat. Sem a variável o jogo roda normalmente, sem guardar nada.
- `Server/Db.cs`: `NpgsqlDataSource` (pacote Npgsql 8), converte `postgresql://...` em string do Npgsql (SSL obrigatório; timeout de 30 s porque a Neon "dorme" após 5 min parada). `EnsureSchemaAsync()` cria as tabelas (sempre com `IF NOT EXISTS`) ao iniciar. `GET /db-health` mostra se a conexão funciona (sem revelar segredos).
- Próximos passos combinados: login com Google (conta ↔ jogador), tabelas de progresso (pontos, títulos, moedas, inventário) e ranking permanente. Quem entrar só com nome continua jogando como hoje, sem salvar.
- **Login com Google (passo 4):** botão "Entrar com o Google" na tela de entrada (Google Identity Services; ID de cliente público em `GOOGLE_CLIENT_ID`, no `game.js` e em `Auth.cs`, origens autorizadas no Google Cloud: `https://atairhubler.github.io` e `http://localhost:5000` — **para testar o botão localmente use a porta 5000**). `POST /auth/google` valida o ID token no Google (`Google.Apis.Auth`), cria/atualiza a linha em `accounts` e devolve uma **sessão própria** (`Sessions` em `Auth.cs`: `v1.<conta>.<expira>.<HMAC>`, 30 dias, assinada com `SESSION_SECRET` no Render; sem ela usa chave aleatória e as sessões caem a cada reinício). O cliente guarda `session`/`accountName` no `localStorage` e, depois de `JoinGame`, chama `Authenticate(sessionToken)` no hub, que liga a conexão à conta (`Player.AccountId`, com `[JsonIgnore]`: nunca vai para os outros jogadores). Quem não entrar com Google joga como sempre.
- **Progresso salvo (passo 6):** para contas Google, `Progress.cs` acumula na memória (pontos, abates de jogadores e de slimes, mortes) e grava no banco a cada 30 s e quando a pessoa sai; títulos conquistados (`account_titles`) e cor do nome/título equipado (`account_profile`) são gravados na hora. Tabelas: `accounts`, `account_stats`, `account_titles`, `account_profile` (criadas por `Db.EnsureSchemaAsync`). Ao fazer `Authenticate` o servidor manda o evento `AccountData` (estatísticas, títulos, cor, título equipado) e o cliente os aplica (`onAccountData`; títulos = união com os do navegador). Menu **☰** no canto superior direito (`#menuBtn`, `#menuList`) com **Ranking** (hub `GetRanking`, top 10 de todos os tempos, linha "você" destacada) e **Perfil** (hub `GetMyStats`: foto, pontos, estatísticas, títulos, "Sair da conta"), cada um numa janela (`openInfo`/`#infoModal`); os comandos `/ranking` e `/perfil` abrem as mesmas janelas. Sem conta Google nada disso é salvo. **Ainda não salvo:** aparência do personagem (cores/gênero) e moedas/itens (próximos passos).

## Interface (HUD e Menu)
- Nova interface em **`ui.css` + `ui.js`** (carregados depois do `game.js`; usam as variáveis dele). Referências visuais do dono em `C:\Users\atair\Downloads\Game\interface\` (imagem 1 = menu em grade de botões, imagem 2 = HUD, imagem 3 = ficha do personagem).
- **HUD (canto superior esquerdo, `#playerHud`):** retrato do personagem com **nível**, barra vermelha de vida (100 fora de combate; a real na arena/floresta), **barra azul de mana**, **barra verde de stamina** e **barra dourada de experiência** (nessa ordem). **Mana** (`ui.js`: `MANA_REGEN_PER_S`=12, `MANA_COST_WEAPON`): cada golpe gasta. **Stamina** (`STAMINA_REGEN_PER_S`=22, `STAMINA_COST_DASH`=30): cada dash gasta. As duas só valem no navegador, recarregam sozinhas e, sem saldo, o golpe/dash não sai e a barra pisca. Avisos curtos no chat (`say`) somem em 4 s; textos longos usam `sayKeep`. **Nível** = 1 + ⌊√(pontos/25)⌋ (pontos de combate: total da conta + sessão). Canto superior direito (`#online`): ⭐ pontos, 🎧 voz, 🎤 mic, 👥 online e o botão de **6 quadradinhos** (`#menuBtn`) que abre o Menu.
- **Menu (`showMenu`)**: tela cheia com grade de botões (Perfil, Classificação, Conquistas, Mapa, Cidade, Ajuda, Configurações; Inventário/Loja/Missões apagados "em breve", e Sair) (Sair é o último botão da grade; não há barra lateral). Cada botão abre uma janela na mesma tela (`openScreen`): **Perfil** (ficha com boneco, nível, estatísticas e títulos que se equipam), **Classificação** (top 10), **Conquistas**, **Mapa** (jogadores por mapa) e **Configurações** (música, efeitos, tela cheia, sair da conta). **Cidade** chama o hub `GoHome` (volta ao vilarejo; espera de 10 s). Ícones são SVG desenhados em `ICON_PATHS` (`ui.js`). Os botões `#muteBtn`/`#sfxBtn` ficam num contêiner escondido (`#settingsSource`) e são movidos para as Configurações enquanto ela está aberta.
- Para criar novas janelas/botões: adicione em `showMenu` (lista `tiles`) e escreva uma função que use `openScreen(titulo, icone)`.
