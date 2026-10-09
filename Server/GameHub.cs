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
            .Where(p => p.Id != me.Id && Math.Abs(p.X - me.X) <= rx && Math.Abs(p.Y - me.Y) <= ry && (filter?.Invoke(p) ?? true))
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
        var near = Nearest(me, 150, 110);
        if (near is null) { await Say("Ninguém por perto para cumprimentar. Chegue mais perto de um amigo."); return; }

        var now = Environment.TickCount64;
        var partner = Players.Values.FirstOrDefault(p => p.Id != me.Id
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

        var rider = Players.Values.FirstOrDefault(p => p.RidingOn == me.Id);
        if (rider is not null) { await Dismount(rider); return; }

        var carrier = Nearest(me, 100, 90, p => p.RidingOn is null && !Players.Values.Any(q => q.RidingOn == p.Id));
        if (carrier is null) { await Say("Ninguém por perto para carregar você. Chegue perto de um amigo que não esteja carregando ninguém."); return; }

        me.RidingOn = carrier.Id;
        if (me.Dancing) { me.Dancing = false; await Clients.Group(Room).SendAsync("PlayerDance", me.Id, false); }
        await Clients.Group(Room).SendAsync("Riding", me.Id, carrier.Id, carrier.X, carrier.Y);
        await Clients.Client(carrier.Id).SendAsync("SystemMessage", $"🐴 {me.Name} subiu nas suas costas! Aperte R para derrubar.");
    }

    private async Task Dismount(Player rider)
    {
        if (rider.RidingOn is not null && Players.TryGetValue(rider.RidingOn, out var carrier))
        {
            rider.X = carrier.X;
            rider.Y = carrier.Y;
        }
        rider.RidingOn = null;
        await Clients.Group(Room).SendAsync("Riding", rider.Id, null, rider.X, rider.Y);
    }

    // Dançar: o estado é compartilhado e a animação é sincronizada pelo relógio, então dançar em grupo fica em uníssono
    public async Task SetDancing(bool on)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || me.Dancing == on) return;
        if (on && me.RidingOn is not null) return;
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

    // Interação com o vilarejo: o cliente só informa qual ponto; o servidor mostra o emote e avisa no chat
    public async Task Interact(int spot)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var me) || spot < 0 || spot >= Spots.Length || !Allow(700)) return;
        await ShowEmote(me.Id, Spots[spot].Emote);
        await SayAll($"{me.Name} {Spots[spot].Text}");
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
        GreetPending.TryRemove(id, out _);
        GreetCount.TryRemove(id, out _);
        DanceStartedAt.TryRemove(id, out _);
        DanceSeconds.TryRemove(id, out _);
        foreach (var key in GrantedTitles.Keys.Where(k => k.StartsWith(id + "|"))) GrantedTitles.TryRemove(key, out _);
        AvatarStore.RemoveOwnedBy(id);

        if (Players.TryRemove(id, out var gone))
        {
            // quem estava nas costas de quem saiu desce no lugar dele
            foreach (var rider in Players.Values.Where(p => p.RidingOn == id))
            {
                rider.RidingOn = null;
                rider.X = gone.X;
                rider.Y = gone.Y;
                await Clients.Group(Room).SendAsync("Riding", rider.Id, null, rider.X, rider.Y);
            }
            await Clients.OthersInGroup(Room).SendAsync("PlayerLeft", id);
            await TagGame.PlayerLeft(hubContext, id);
        }

        await base.OnDisconnectedAsync(exception);
    }
}

public record ChatMessage(string Id, string Name, string Text);
