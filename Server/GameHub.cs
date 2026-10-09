using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;

public class GameHub : Hub
{
    private const string Room = "ForestMap";
    private static readonly ConcurrentDictionary<string, Player> Players = new();

    // Chat: histórico curto em memória + limite de frequência por conexão
    private const int MaxChatChars = 200, MaxHistory = 30;
    private static readonly Queue<ChatMessage> History = new();
    private static readonly ConcurrentDictionary<string, long> LastChatAt = new();

    // Emotes: só o índice viaja; os ícones ficam no cliente
    private const int EmoteCount = 6;
    private static readonly ConcurrentDictionary<string, long> LastEmoteAt = new();

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
        await Clients.OthersInGroup(Room).SendAsync("PlayerJoined", player);
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
        if (!Players.ContainsKey(Context.ConnectionId) || id < 0 || id >= EmoteCount) return;
        var now = Environment.TickCount64;
        if (LastEmoteAt.TryGetValue(Context.ConnectionId, out var last) && now - last < 500) return;
        LastEmoteAt[Context.ConnectionId] = now;
        await Clients.OthersInGroup(Room).SendAsync("PlayerEmote", Context.ConnectionId, id);
    }

    public async Task UpdatePosition(float x, float y)
    {
        if (!Players.TryGetValue(Context.ConnectionId, out var player)) return;
        player.X = x;
        player.Y = y;
        await Clients.OthersInGroup(Room).SendAsync("PlayerMoved", player.Id, x, y);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        LastChatAt.TryRemove(Context.ConnectionId, out _);
        LastEmoteAt.TryRemove(Context.ConnectionId, out _);
        AvatarStore.RemoveOwnedBy(Context.ConnectionId);
        if (Players.TryRemove(Context.ConnectionId, out _))
            await Clients.OthersInGroup(Room).SendAsync("PlayerLeft", Context.ConnectionId);

        await base.OnDisconnectedAsync(exception);
    }
}

public record ChatMessage(string Id, string Name, string Text);
