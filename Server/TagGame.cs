using Microsoft.AspNetCore.SignalR;

// Pique-pega: um jogador é o "pegador"; encostar em outro passa a vez.
// Vence quem ficou menos tempo como pegador. Tudo em memória, uma partida por vez.
public static class TagGame
{
    private const int DurationSeconds = 90;
    private const double ImmunitySeconds = 2; // depois de pegar alguém, o novo pegador não pode ser pego de volta na hora

    private static readonly object Gate = new();
    private static bool _active;
    private static string? _itId;
    private static DateTime _endsAt, _lastTransfer;
    private static readonly Dictionary<string, double> ItSeconds = new();
    private static readonly HashSet<string> Participants = new();
    private static CancellationTokenSource? _cts;
    private static readonly Random Rng = new();

    public static bool IsParticipant(string id)
    {
        lock (Gate) return _active && Participants.Contains(id);
    }

    public static object Snapshot()
    {
        lock (Gate)
        {
            var itName = _itId is not null && GameHub.Players.TryGetValue(_itId, out var it) ? it.Name : null;
            var remaining = _active ? Math.Max(0L, (long)(_endsAt - DateTime.UtcNow).TotalMilliseconds) : 0L;
            return new { active = _active, itId = _itId, itName, remainingMs = remaining };
        }
    }

    private static Task Broadcast(IHubContext<GameHub> hub) =>
        hub.Clients.Group(GameHub.Room).SendAsync("TagState", Snapshot());

    private static Task Say(IHubContext<GameHub> hub, string text) =>
        hub.Clients.Group(GameHub.Room).SendAsync("SystemMessage", text);

    public static async Task Start(IHubContext<GameHub> hub, string starterId)
    {
        string? refuse = null, itName = null;
        lock (Gate)
        {
            if (_active) refuse = "O pique-pega já está em andamento. Use /pique parar para encerrar.";
            else if (GameHub.Players.Values.Count(p => p.Map == "village") < 2) refuse = "São necessários pelo menos 2 jogadores para o pique-pega.";
            else
            {
                var ids = GameHub.Players.Values.Where(p => p.Map == "village").Select(p => p.Id).ToList();
                _itId = ids[Rng.Next(ids.Count)];
                Participants.Clear();
                ItSeconds.Clear();
                foreach (var id in ids) { Participants.Add(id); ItSeconds[id] = 0; }
                _active = true;
                _lastTransfer = DateTime.UtcNow;
                _endsAt = DateTime.UtcNow.AddSeconds(DurationSeconds);
                _cts = new CancellationTokenSource();
                itName = GameHub.Players.TryGetValue(_itId, out var it) ? it.Name : "alguém";
                var token = _cts.Token;
                _ = Task.Run(() => Loop(hub, token));
            }
        }

        if (refuse is not null) { await hub.Clients.Client(starterId).SendAsync("SystemMessage", refuse); return; }
        await Say(hub, $"🏃 Pique-pega começou! {itName} é o pegador. Fujam! ({DurationSeconds} segundos)");
        await Broadcast(hub);
    }

    public static async Task Stop(IHubContext<GameHub> hub, string byId)
    {
        bool active;
        lock (Gate) active = _active;
        if (!active) { await hub.Clients.Client(byId).SendAsync("SystemMessage", "Não há pique-pega em andamento."); return; }
        var name = GameHub.Players.TryGetValue(byId, out var p) ? p.Name : "Alguém";
        await End(hub, $"{name} encerrou o pique-pega.");
    }

    private static async Task Loop(IHubContext<GameHub> hub, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(100, ct);
                string? say = null;
                var ended = false;
                lock (Gate)
                {
                    if (!_active) return;
                    if (_itId is not null) ItSeconds[_itId] = ItSeconds.GetValueOrDefault(_itId) + 0.1;

                    if (DateTime.UtcNow >= _endsAt) ended = true;
                    else if (_itId is not null && GameHub.Players.TryGetValue(_itId, out var it) && it.RidingOn is null && it.Map == "village"
                             && (DateTime.UtcNow - _lastTransfer).TotalSeconds >= ImmunitySeconds)
                    {
                        // quem está nas costas de alguém fica a salvo
                        var victim = GameHub.Players.Values.FirstOrDefault(p => p.Id != it.Id && p.RidingOn is null && p.Map == "village"
                            && Math.Abs(p.X - it.X) < 48 && Math.Abs(p.Y - it.Y) < 64);
                        if (victim is not null)
                        {
                            _itId = victim.Id;
                            _lastTransfer = DateTime.UtcNow;
                            say = $"🔴 {it.Name} pegou {victim.Name}! Agora {victim.Name} é o pegador.";
                        }
                    }
                }

                if (ended) { await End(hub, "O tempo acabou!"); return; }
                if (say is not null) { await Say(hub, say); await Broadcast(hub); }
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task End(IHubContext<GameHub> hub, string reason)
    {
        var ranking = new List<(string Id, string Name, double Secs)>();
        lock (Gate)
        {
            if (!_active) return;
            _active = false;
            _itId = null;
            _cts?.Cancel();
            foreach (var id in Participants)
                if (GameHub.Players.TryGetValue(id, out var p))
                    ranking.Add((id, p.Name, ItSeconds.GetValueOrDefault(id)));
            ranking = ranking.OrderBy(r => r.Secs).ToList();
        }

        var medals = new[] { "🥇", "🥈", "🥉" };
        var lines = new List<string> { $"🏁 {reason} Resultado do pique-pega:" };
        for (var i = 0; i < ranking.Count; i++)
            lines.Add($"{(i < 3 ? medals[i] : $"{i + 1}º")} {ranking[i].Name} — {ranking[i].Secs:0}s como pegador");
        await Say(hub, string.Join("\n", lines));
        await Broadcast(hub);

        if (ranking.Count >= 2 && reason.StartsWith("O tempo"))
            await GameHub.AwardTitle(hub, ranking[0].Id, "Campeão do Pique-Pega");
    }

    // Quem sai no meio da partida: se era o pegador, passa para outro; se sobrar menos de 2, encerra
    public static async Task PlayerLeft(IHubContext<GameHub> hub, string id)
    {
        string? say = null;
        var end = false;
        lock (Gate)
        {
            if (!_active) return;
            Participants.Remove(id);
            var others = GameHub.Players.Keys.Where(k => k != id).ToList();
            if (others.Count < 2) end = true;
            else if (_itId == id)
            {
                _itId = others[Rng.Next(others.Count)];
                _lastTransfer = DateTime.UtcNow;
                say = $"O pegador saiu! {(GameHub.Players.TryGetValue(_itId, out var p) ? p.Name : "Alguém")} é o novo pegador.";
            }
        }
        if (end) { await End(hub, "Jogadores insuficientes."); return; }
        if (say is not null) { await Say(hub, say); await Broadcast(hub); }
    }
}
