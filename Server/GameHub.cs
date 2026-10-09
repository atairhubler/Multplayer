using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

public class GameHub : Hub
{
    private const string Room = "ForestMap";
    private static readonly ConcurrentDictionary<string, Player> Players = new();

    public async Task JoinGame(string name, string character)
    {
        var player = new Player
        {
            Id = Context.ConnectionId,
            Name = string.IsNullOrWhiteSpace(name) ? "Anon" : name.Trim()[..Math.Min(name.Trim().Length, 16)],
            CharacterSprite = character,
            X = 100,
            Y = 400
        };

        // Lista dos que já estavam conectados (antes de adicionar o novo)
        var existing = Players.Values.ToList();
        Players[player.Id] = player;

        await Groups.AddToGroupAsync(Context.ConnectionId, Room);

        await Clients.Caller.SendAsync("ExistingPlayers", existing);
        await Clients.OthersInGroup(Room).SendAsync("PlayerJoined", player);
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
        if (Players.TryRemove(Context.ConnectionId, out _))
            await Clients.OthersInGroup(Room).SendAsync("PlayerLeft", Context.ConnectionId);

        await base.OnDisconnectedAsync(exception);
    }
}
