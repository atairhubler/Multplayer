using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;

public class GameHub(IHubContext<GameHub> hubContext) : Hub
{
    public const string Room = "ForestMap";
    internal static readonly ConcurrentDictionary<string, Player> Players = new();

    // Chat: histórico curto em memória + limite de frequência por conexão
    private const int MaxChatChars = 200, MaxHistory = 30;
    private static readonly Queue<ChatMessage> History = new();
    private static readonly ConcurrentDictionary<string, long> LastChatAt = new();

    // Emotes: só o índice viaja; os ícones ficam no cliente. 0–5 são os do teclado;
    // os demais (6+) são disparados pelo servidor nas ações sociais e nos pontos do vilarejo.
    private const int UserEmoteCount = 6;
    private static readonly ConcurrentDictionary<string, long> LastEmoteAt = new();
    private static readonly ConcurrentDictionary<string, long> LastActionAt = new();
    // Limites próprios do dash e da troca de mapa: não podem disputar o limite das ações sociais (o dash bloqueava a saída da arena)
    private static readonly ConcurrentDictionary<string, long> LastDashAt = new(), LastMapAt = new();

    // Títulos que podem ser exibidos ao lado do nome
    internal static readonly string[] AllowedTitles = { "Campeão do Pique-Pega", "Cumprimentador", "Dançarino" };
    private static readonly ConcurrentDictionary<string, byte> GrantedTitles = new();
    private static readonly Regex ColorPattern = new(@"^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

    // Estatísticas da sessão para conquistar títulos
    private static readonly ConcurrentDictionary<string, int> GreetCount = new();
    private static readonly ConcurrentDictionary<string, long> GreetPending = new();
    private static readonly ConcurrentDictionary<string, long> DanceStartedAt = new();
    private static readonly ConcurrentDictionary<string, double> DanceSeconds = new();

    // Pontos de interação do vilarejo (mesma ordem do cliente): emote + texto da mensagem no chat
    private static readonly (int Emote, string Text)[] Spots =
    {
        (20, "bebeu água na fonte 💧"), (21, "comprou pão na padaria 🍞"), (22, "martelou na ferraria 🔨"),
        (23, "olhou as frutas da barraca 🍎"), (24, "provou o queijo da barraca 🧀"),
        (25, "comprou tomates na barraca 🍅"), (26, "bateu na porta... ninguém atendeu 🚪"),
    };

    // Chat de voz (WebRTC): o servidor só sabe quem está na voz e repassa as mensagens de conexão (offer/answer/ICE).
    // O áudio em si vai direto entre os navegadores.
    private static readonly object VoiceLock = new();
    private static readonly HashSet<string> VoiceMembers = new();

    public async Task JoinGame(string name, string character)
    {
        var sprite = SanitizeCharacter(character);
        if (AvatarPath.IsMatch(sprite) && !AvatarStore.Claim(sprite[9..], Context.ConnectionId)) sprite = DefaultCharacter;

        var player = new Player
        {
            Id = Context.ConnectionId,
            Name = string.IsNullOrWhiteSpace(name) ? "Anon" : name.Trim()[..Math.Min(name.Trim().Length, 16)],
            CharacterSprite = sprite,
            X = 100,
            Y = 400
        };

        // Lista dos que já estavam conectados (antes de adicionar o novo)
        var existing = Players.Values.ToList();
        Players[player.Id] = player;

        await Groups.AddToGroupAsync(Context.ConnectionId, Room);

        await Clients.Caller.SendAsync("ExistingPlayers", existing);
        ChatMessage[] history;
        lock (History) history = History.ToArray();
        await Clients.Caller.SendAsync("ChatHistory", history);
        await Clients.Caller.SendAsync("TagState", TagGame.Snapshot());
        string[] inVoice;
        lock (VoiceLock) inVoice = VoiceMembers.Where(Players.ContainsKey).ToArray();
        await Clients.Caller.SendAsync("VoiceMembers", inVoice);
        await Clients.OthersInGroup(Room).SendAsync("PlayerJoined", player);
    }

    // Cor do nome e título exibido (chamado logo depois de JoinGame; servidores antigos não têm este método)
    public async Task UpdateProfile(string? nameColor, string? title)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var p)) return;
        p.NameColor = nameColor is not null && ColorPattern.IsMatch(nameColor) ? nameColor.ToLowerInvariant() : null;
        p.Title = title is not null && AllowedTitles.Contains(title) ? title : null;
        await Clients.Group(Room).SendAsync("PlayerProfile", p.Id, p.NameColor, p.Title);
    }

    private const string DefaultCharacter = "char:m:4a2c17:f1c27d:3498db";
    private static readonly Regex DollConfig = new(@"^char:[mf]:[0-9a-f]{6}:[0-9a-f]{6}:[0-9a-f]{6}$", RegexOptions.Compiled);
    private static readonly Regex AvatarPath = new(@"^/avatars/[0-9a-f]{32}$", RegexOptions.Compiled);
    private static readonly string[] Colors = { "red", "blue", "green", "yellow" };
    private static readonly Regex ImageDataUrl = new(@"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$", RegexOptions.Compiled);
    private const int MaxImageChars = 40_000;

    // Aceita uma cor conhecida ou uma imagem pequena em data URL; qualquer outra coisa vira o boneco padrão
    private static string SanitizeCharacter(string? character)
    {
        if (character is null) return DefaultCharacter;
        if (DollConfig.IsMatch(character)) return character; // boneco: gênero + cores de cabelo/pele/roupa
        if (Colors.Contains(character)) return character;
        if (character.Length <= MaxImageChars && ImageDataUrl.IsMatch(character)) return character;
        if (AvatarPath.IsMatch(character)) return character; // dono é verificado em JoinGame
        return DefaultCharacter;
    }

    public async Task SendMessage(string text)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var player)) return;
        text = (text ?? "").Trim();
        if (text.Length == 0) return;
        if (text.Length > MaxChatChars) text = text[..MaxChatChars];

        var now = Environment.TickCount64;
        if (LastChatAt.TryGetValue(Context.ConnectionId, out var last) && now - last < 400) return;
        LastChatAt[Context.ConnectionId] = now;

        var msg = new ChatMessage(player.Id, player.Name, text);
        lock (History)
        {
            History.Enqueue(msg);
            while (History.Count > MaxHistory) History.Dequeue();
        }
        await Clients.Group(Room).SendAsync("ChatMessage", msg);
    }

    public async Task Emote(int id)
    {
        if (!Players.ContainsKey(Context.ConnectionId) || id < 0 || id >= UserEmoteCount) return;
        var now = Environment.TickCount64;
        if (LastEmoteAt.TryGetValue(Context.ConnectionId, out var last) && now - last < 500) return;
        LastEmoteAt[Context.ConnectionId] = now;
        await Clients.OthersInGroup(Room).SendAsync("PlayerEmote", Context.ConnectionId, id);
    }

    public async Task UpdatePosition(float x, float y)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var player)) return;
        if (player.RidingOn is not null) return; // quem está nas costas de alguém segue o carregador
        x = Math.Clamp(x, 0, 1280);
        y = Math.Clamp(y, 0, 600);
        player.X = x;
        player.Y = y;
        await Clients.OthersInGroup(Room).SendAsync("PlayerMoved", player.Id, x, y);
    }

    // ---------- Ações sociais ----------

    private bool Allow(int ms)
    {
        var now = Environment.TickCount64;
        if (LastActionAt.TryGetValue(Context.ConnectionId, out var last) && now - last < ms) return false;
        LastActionAt[Context.ConnectionId] = now;
        return true;
    }

    private Task Say(string text) => Clients.Caller.SendAsync("SystemMessage", text);
    private Task SayAll(string text) => Clients.Group(Room).SendAsync("SystemMessage", text);
    private Task ShowEmote(string id, int emote) => Clients.Group(Room).SendAsync("PlayerEmote", id, emote);

    private static Player? Nearest(Player me, float rx, float ry, Func<Player, bool>? filter = null) =>
        Players.Values
            .Where(p => p.Id != me.Id && p.Map == me.Map && Math.Abs(p.X - me.X) <= rx && Math.Abs(p.Y - me.Y) <= ry && (filter?.Invoke(p) ?? true))
            .OrderBy(p => Math.Abs(p.X - me.X) + Math.Abs(p.Y - me.Y))
            .FirstOrDefault();

    internal static async Task AwardTitle(IHubContext<GameHub> hub, string connectionId, string title)
    {
        if (!GrantedTitles.TryAdd(connectionId + "|" + title, 0)) return;
        await hub.Clients.Client(connectionId).SendAsync("TitleEarned", title);
    }

    // Cumprimentar: os dois precisam chamar, um depois do outro, em até 5 segundos
    public async Task Greet()
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || !Allow(600)) return;
        if (me.Map != "village") { await Say("Na arena não dá para cumprimentar. Volte ao vilarejo."); return; }
        var near = Nearest(me, 150, 110);
        if (near is null) { await Say("Ninguém por perto para cumprimentar. Chegue mais perto de um amigo."); return; }

        var now = Environment.TickCount64;
        var partner = Players.Values.FirstOrDefault(p => p.Id != me.Id && p.Map == me.Map
            && Math.Abs(p.X - me.X) <= 150 && Math.Abs(p.Y - me.Y) <= 110
            && GreetPending.TryGetValue(p.Id, out var t) && now - t < 5000);

        if (partner is null)
        {
            GreetPending[me.Id] = now;
            await ShowEmote(me.Id, 6);
            await Say($"🖐️ Esperando {near.Name}... peça para um amigo por perto apertar H em até 5 segundos.");
            return;
        }

        GreetPending.TryRemove(partner.Id, out _);
        GreetPending.TryRemove(me.Id, out _);
        await ShowEmote(me.Id, 7);
        await ShowEmote(partner.Id, 7);
        await SayAll($"🤝 {me.Name} e {partner.Name} se cumprimentaram!");
        foreach (var id in new[] { me.Id, partner.Id })
            if (GreetCount.AddOrUpdate(id, 1, (_, n) => n + 1) >= 5)
                await AwardTitle(hubContext, id, "Cumprimentador");
    }

    // Empurrar: joga o amigo mais próximo para longe
    public async Task Push()
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || !Allow(900)) return;
        if (me.Map != "village") { await Say("Na arena, use as armas! Empurrar é só no vilarejo."); return; }
        if (me.RidingOn is not null) { await Say("Desça das costas do amigo antes de empurrar."); return; }
        var target = Nearest(me, 90, 80, p => p.RidingOn is null);
        if (target is null) { await Say("Ninguém ao alcance para empurrar. Chegue bem perto de um amigo."); return; }

        var dir = target.X >= me.X ? 1 : -1;
        await Clients.Client(target.Id).SendAsync("Pushed", dir);
        await Clients.Client(target.Id).SendAsync("SystemMessage", $"💢 {me.Name} empurrou você!");
        await ShowEmote(me.Id, 8);
    }

    // Subir nas costas de um amigo; de novo para descer (ou, quem carrega, para derrubar quem está nas costas)
    public async Task ToggleRide()
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || !Allow(600)) return;

        if (me.RidingOn is not null) { await Dismount(me); return; }
        if (me.Map != "village") { await Say("Subir nas costas só funciona no vilarejo."); return; }

        var rider = Players.Values.FirstOrDefault(p => p.RidingOn == me.Id);
        if (rider is not null) { await Dismount(rider); return; }

        // Dá para subir em quem está no topo de uma torre: o carregador não pode ter ninguém nas costas e a torre tem limite de altura
        var carrier = Players.Values
            .Where(p => p.Id != me.Id && p.Map == me.Map && p.RidingOn != me.Id && TowerDepth(p) < MaxTower && !Players.Values.Any(q => q.RidingOn == p.Id))
            .Select(p => (Carrier: p, Base: TowerBase(p)))
            .Where(t => Math.Abs(t.Base.X - me.X) <= 100 && Math.Abs(t.Base.Y - me.Y) <= 90)
            .OrderBy(t => Math.Abs(t.Base.X - me.X) + Math.Abs(t.Base.Y - me.Y))
            .Select(t => t.Carrier)
            .FirstOrDefault();
        if (carrier is null) { await Say("Ninguém por perto para carregar você. Chegue perto de um amigo (ou de uma torre) que tenha espaço nas costas."); return; }

        var bas = TowerBase(carrier);
        me.X = bas.X;
        me.Y = bas.Y;
        me.RidingOn = carrier.Id;
        await Clients.Group(Room).SendAsync("Riding", me.Id, carrier.Id, bas.X, bas.Y);
        await Clients.Client(carrier.Id).SendAsync("SystemMessage", $"🐴 {me.Name} subiu nas suas costas! Aperte R para derrubar.");
    }

    // Torre de jogadores: até MaxTower pessoas empilhadas (a base conta). RidingOn aponta para quem está embaixo.
    private const int MaxTower = 10;

    // Quem está no chão no pé da torre (a posição X/Y de quem está montado fica velha, só a base se move)
    private static Player TowerBase(Player p)
    {
        for (var i = 0; i < MaxTower + 2 && p.RidingOn is not null && Players.TryGetValue(p.RidingOn, out var below); i++) p = below;
        return p;
    }

    // Quantas pessoas há da base até p, incluindo os dois (base sozinha = 1)
    private static int TowerDepth(Player p)
    {
        var n = 1;
        for (; n <= MaxTower + 2 && p.RidingOn is not null && Players.TryGetValue(p.RidingOn, out var below); n++) p = below;
        return n;
    }

    private async Task Dismount(Player rider)
    {
        if (rider.RidingOn is not null && Players.TryGetValue(rider.RidingOn, out var carrier))
        {
            var bas = TowerBase(carrier);
            rider.X = bas.X;
            rider.Y = bas.Y;
        }
        rider.RidingOn = null;
        await Clients.Group(Room).SendAsync("Riding", rider.Id, null, rider.X, rider.Y);
    }

    // Dançar: o estado é compartilhado e a animação é sincronizada pelo relógio, então dançar em grupo fica em uníssono
    public async Task SetDancing(bool on)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || me.Dancing == on) return;
        if (on && me.Map != "village") return; // na arena não se dança
        me.Dancing = on;

        if (on)
        {
            DanceStartedAt[me.Id] = Environment.TickCount64;
            var others = Players.Values.Count(p => p.Id != me.Id && p.Dancing && Math.Abs(p.X - me.X) <= 300);
            await ShowEmote(me.Id, 9);
            if (others > 0) await SayAll($"🎉 {me.Name} entrou na dança! ({others + 1} dançando juntos)");
        }
        else await StopDanceAccounting(me.Id);

        await Clients.Group(Room).SendAsync("PlayerDance", me.Id, on);
    }

    private async Task StopDanceAccounting(string id)
    {
        if (!DanceStartedAt.TryRemove(id, out var started)) return;
        var total = DanceSeconds.AddOrUpdate(id, (Environment.TickCount64 - started) / 1000.0, (_, s) => s + (Environment.TickCount64 - started) / 1000.0);
        if (total >= 90) await AwardTitle(hubContext, id, "Dançarino");
    }

    // ---------- Mapas, arena e dash ----------

    // Muda de mapa andando até a borda: vilarejo (borda direita) <-> arena (borda esquerda)
    public async Task ChangeMap(string map)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me)) return;
        var nowMs = Environment.TickCount64;
        if (LastMapAt.TryGetValue(me.Id, out var lastMap) && nowMs - lastMap < 500) return;
        LastMapAt[me.Id] = nowMs;
        if (map != "village" && map != ArenaGame.MapName) return;
        if (me.Map == map) return;
        if (map == ArenaGame.MapName && me.X < 1280 - 70) { await Say("Ande até o fim da rua, à direita, para chegar à arena."); return; }
        if (map == "village" && me.X > 120) return;
        if (me.RidingOn is not null) { await Say("Desça das costas do amigo antes de mudar de mapa."); return; }
        if (TagGame.IsParticipant(me.Id)) { await Say("Termine o pique-pega antes de ir para a arena."); return; }

        foreach (var rider in Players.Values.Where(p => p.RidingOn == me.Id).ToList()) await Dismount(rider); // quem estava nas costas fica para trás
        if (me.Dancing) { me.Dancing = false; await StopDanceAccounting(me.Id); await Clients.Group(Room).SendAsync("PlayerDance", me.Id, false); }

        var toArena = map == ArenaGame.MapName;
        me.Map = map;
        me.X = toArena ? ArenaGame.EntryX : 1220;
        me.Y = ArenaGame.SpawnY;
        if (toArena) await ArenaGame.Enter(hubContext, me.Id); else await ArenaGame.Leave(hubContext, me.Id);
        await Clients.Group(Room).SendAsync("PlayerMap", me.Id, me.Map, me.X, me.Y);
        if (toArena) await Clients.Caller.SendAsync("ArenaState", ArenaGame.Snapshot());
    }

    public Task SetWeapon(int weapon) =>
        Players.ContainsKey(Context.ConnectionId) ? ArenaGame.SetWeapon(hubContext, Context.ConnectionId, weapon) : Task.CompletedTask;

    public async Task Attack(int dir)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || me.Map != ArenaGame.MapName) return;
        await ArenaGame.Attack(hubContext, me, dir);
    }

    // Dash: o movimento em si é do cliente; aqui só avisamos os outros para desenharem o efeito
    public async Task Dash(int dir)
    {
        if (!Players.ContainsKey(Context.ConnectionId)) return;
        var nowMs = Environment.TickCount64;
        if (LastDashAt.TryGetValue(Context.ConnectionId, out var lastDash) && nowMs - lastDash < 200) return;
        LastDashAt[Context.ConnectionId] = nowMs;
        await Clients.OthersInGroup(Room).SendAsync("PlayerDash", Context.ConnectionId, dir < 0 ? -1 : 1);
    }

    // Interação com o vilarejo: o cliente só informa qual ponto; o servidor mostra o emote e avisa no chat
    public async Task Interact(int spot)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || me.Map != "village" || spot < 0 || spot >= Spots.Length || !Allow(700)) return;
        await ShowEmote(me.Id, Spots[spot].Emote);
        await SayAll($"{me.Name} {Spots[spot].Text}");
    }

    // Entra no chat de voz. Quem entra liga para cada pessoa que já estava (assim só um lado inicia cada conexão).
    public async Task JoinVoice()
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me)) return;
        string[] roster;
        lock (VoiceLock)
        {
            roster = VoiceMembers.Where(Players.ContainsKey).ToArray();
            VoiceMembers.Add(me.Id);
        }
        await Clients.Caller.SendAsync("VoiceRoster", roster);
        await Clients.OthersInGroup(Room).SendAsync("VoiceState", me.Id, true);
        await SayAll($"🎧 {me.Name} entrou no chat de voz.");
    }

    public async Task LeaveVoice()
    {
        bool removed;
        lock (VoiceLock) removed = VoiceMembers.Remove(Context.ConnectionId);
        if (removed) await Clients.OthersInGroup(Room).SendAsync("VoiceState", Context.ConnectionId, false);
    }

    // Repassa uma mensagem de conexão de voz (SDP/ICE em JSON) para outro participante da voz
    public async Task VoiceSignal(string toId, string payload)
    {
        if (payload is null || payload.Length > 20_000 || toId == Context.ConnectionId) return;
        lock (VoiceLock)
            if (!VoiceMembers.Contains(Context.ConnectionId) || !VoiceMembers.Contains(toId)) return;
        await Clients.Client(toId).SendAsync("VoiceSignal", Context.ConnectionId, payload);
    }

    // Compartilhamento de tela ("projeção"): quem compartilha avisa; cada espectador liga para quem compartilha
    // (WebRTC, vídeo só de ida). O servidor apenas guarda o estado e repassa offer/answer/ICE.
    public async Task StartShare()
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || me.Sharing || !Allow(1500)) return;
        me.Sharing = true;
        await Clients.OthersInGroup(Room).SendAsync("ShareState", me.Id, true);
        await SayAll($"📺 {me.Name} começou a compartilhar a tela. Clique na projeção sobre a cabeça do jogador para ampliar.");
    }

    public async Task StopShare()
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || !me.Sharing) return;
        me.Sharing = false;
        await Clients.OthersInGroup(Room).SendAsync("ShareState", me.Id, false);
    }

    // Repassa mensagens de conexão do compartilhamento; um dos dois lados precisa ser quem compartilha
    public async Task ShareSignal(string toId, string payload)
    {
        if (payload is null || payload.Length > 20_000 || toId == Context.ConnectionId) return;
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || !Players.TryGetValue(toId, out var to)) return;
        if (!me.Sharing && !to.Sharing) return;
        await Clients.Client(toId).SendAsync("ShareSignal", Context.ConnectionId, payload);
    }

    // Pique-pega
    public Task StartTag() => TagGame.Start(hubContext, Context.ConnectionId);
    public Task StopTag() => TagGame.Stop(hubContext, Context.ConnectionId);

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var id = Context.ConnectionId;
        LastChatAt.TryRemove(id, out _);
        LastEmoteAt.TryRemove(id, out _);
        LastActionAt.TryRemove(id, out _);
        LastDashAt.TryRemove(id, out _);
        LastMapAt.TryRemove(id, out _);
        GreetPending.TryRemove(id, out _);
        GreetCount.TryRemove(id, out _);
        DanceStartedAt.TryRemove(id, out _);
        DanceSeconds.TryRemove(id, out _);
        foreach (var key in GrantedTitles.Keys.Where(k => k.StartsWith(id + "|"))) GrantedTitles.TryRemove(key, out _);
        AvatarStore.RemoveOwnedBy(id);

        lock (VoiceLock) VoiceMembers.Remove(id);
        await ArenaGame.Disconnected(hubContext, id);

        if (Players.TryRemove(id, out var gone))
        {
            // quem estava nas costas de quem saiu desce no lugar dele
            var bas = TowerBase(gone);
            foreach (var rider in Players.Values.Where(p => p.RidingOn == id))
            {
                rider.RidingOn = null;
                rider.X = bas.X;
                rider.Y = bas.Y;
                await Clients.Group(Room).SendAsync("Riding", rider.Id, null, rider.X, rider.Y);
            }
            await Clients.OthersInGroup(Room).SendAsync("PlayerLeft", id);
            await TagGame.PlayerLeft(hubContext, id);
        }

        await base.OnDisconnectedAsync(exception);
    }
}

public record ChatMessage(string Id, string Name, string Text);
