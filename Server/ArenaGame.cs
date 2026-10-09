using Microsoft.AspNetCore.SignalR;

// Arena: mapa de luta. Cada jogador tem vida, escolhe uma arma e ganha pontos ao acertar/derrotar os outros.
// O servidor decide tudo (alcance, recarga, dano, flechas); os clientes só desenham os efeitos. Estado só em memória.
public static class ArenaGame
{
    public const string MapName = "arena";
    public const float EntryX = 80, SpawnY = 540; // y do centro do boneco; ele cai até a calçada
    private const int MaxHp = 100, RespawnMs = 3000, ImmuneMs = 2000, KillPoints = 10, HitPoints = 1;
    private const float HalfBody = 22, ReachY = 60;
    private const float ArrowSpeed = 600, ArrowRange = 650, ArrowHitX = 26, ArrowHitY = 50; // px/s e px

    // Mesma ordem do cliente: Espada, Lança, Arco, Martelo, Garras
    private record Weapon(string Name, float Range, int Damage, int CooldownMs, float Knock, float Lift, bool Projectile);
    private static readonly Weapon[] Weapons =
    {
        new("Espada", 70, 12, 450, 300, 140, false),
        new("Lança", 120, 10, 650, 220, 100, false),
        new("Arco", 0, 8, 800, 200, 80, true),
        new("Martelo", 60, 25, 1100, 640, 300, false),
        new("Garras", 50, 7, 250, 120, 60, false),
    };

    private class State { public int Hp = MaxHp, Weapon, Score; public long LastAttackAt, ImmuneUntil, RespawnAt; public bool Alive = true; }
    private class Arrow { public int Id; public string Owner = ""; public float X, Y, Dir, Traveled; }

    private static readonly object Gate = new();
    private static readonly Dictionary<string, State> InArena = new();
    private static readonly Dictionary<string, int> Scores = new(); // a pontuação fica enquanto o jogador estiver conectado
    private static readonly List<Arrow> Arrows = new();
    private static int _nextArrow;
    private static bool _loopRunning;

    private static Task Send(IHubContext<GameHub> hub, string method, params object?[] args) =>
        hub.Clients.Group(GameHub.Room).SendCoreAsync(method, args); // SendCoreAsync: cada item de args vira um argumento do cliente

    // Lista para o ranking e as barras de vida (só quem está na arena)
    public static object Snapshot()
    {
        lock (Gate)
            return InArena
                .Where(kv => GameHub.Players.ContainsKey(kv.Key))
                .Select(kv => new { id = kv.Key, name = GameHub.Players[kv.Key].Name, hp = kv.Value.Hp, score = kv.Value.Score, weapon = kv.Value.Weapon, alive = kv.Value.Alive })
                .OrderByDescending(p => p.score).ThenBy(p => p.name)
                .ToList();
    }

    private static Task BroadcastState(IHubContext<GameHub> hub) => Send(hub, "ArenaState", Snapshot());

    public static async Task Enter(IHubContext<GameHub> hub, string id)
    {
        lock (Gate)
        {
            InArena[id] = new State { Score = Scores.GetValueOrDefault(id), Weapon = InArena.TryGetValue(id, out var old) ? old.Weapon : 0, ImmuneUntil = Environment.TickCount64 + ImmuneMs };
            if (!_loopRunning) { _loopRunning = true; _ = Task.Run(() => Loop(hub)); }
        }
        await BroadcastState(hub);
    }

    public static async Task Leave(IHubContext<GameHub> hub, string id)
    {
        bool had;
        lock (Gate) { had = InArena.Remove(id); Arrows.RemoveAll(a => a.Owner == id); }
        if (had) await BroadcastState(hub);
    }

    public static async Task Disconnected(IHubContext<GameHub> hub, string id)
    {
        lock (Gate) Scores.Remove(id);
        await Leave(hub, id);
    }

    public static async Task SetWeapon(IHubContext<GameHub> hub, string id, int weapon)
    {
        if (weapon < 0 || weapon >= Weapons.Length) return;
        lock (Gate)
        {
            if (!InArena.TryGetValue(id, out var st) || st.Weapon == weapon) return;
            st.Weapon = weapon;
        }
        await BroadcastState(hub);
    }

    public static async Task Attack(IHubContext<GameHub> hub, Player me, int dir)
    {
        dir = dir < 0 ? -1 : 1;
        var events = new List<(string Method, object?[] Args)>();
        bool stateChanged = false;
        lock (Gate)
        {
            if (!InArena.TryGetValue(me.Id, out var st) || !st.Alive) return;
            var now = Environment.TickCount64;
            var w = Weapons[st.Weapon];
            if (now - st.LastAttackAt < w.CooldownMs) return;
            st.LastAttackAt = now;
            events.Add(("ArenaSwing", new object?[] { me.Id, st.Weapon, dir }));

            if (w.Projectile)
            {
                var arrow = new Arrow { Id = ++_nextArrow, Owner = me.Id, X = me.X + dir * 24, Y = me.Y - 6, Dir = dir };
                Arrows.Add(arrow);
                events.Add(("ArrowFired", new object?[] { arrow.Id, me.Id, arrow.X, arrow.Y, dir }));
            }
            else
            {
                foreach (var (vid, vst) in InArena.ToList())
                {
                    if (vid == me.Id || !vst.Alive || vst.ImmuneUntil > now || !GameHub.Players.TryGetValue(vid, out var v)) continue;
                    var dx = (v.X - me.X) * dir;
                    if (dx < -10 || dx > w.Range + HalfBody || Math.Abs(v.Y - me.Y) > ReachY) continue;
                    Damage(me.Id, st, vid, vst, w, dir, 0, now, events);
                    stateChanged = true;
                }
            }
        }
        foreach (var (m, a) in events) await Send(hub, m, a);
        if (stateChanged) await BroadcastState(hub);
    }

    // Aplica o dano (dentro do lock): pontos, abate e eventos
    private static void Damage(string attackerId, State attacker, string victimId, State victim, Weapon w, int dir, int arrowId, long now, List<(string, object?[])> events)
    {
        victim.Hp = Math.Max(0, victim.Hp - w.Damage);
        attacker.Score += HitPoints;
        events.Add(("ArenaHit", new object?[] { attackerId, victimId, w.Damage, victim.Hp, dir, w.Knock, w.Lift, arrowId }));
        if (victim.Hp > 0) { Scores[attackerId] = attacker.Score; return; }
        victim.Alive = false;
        victim.RespawnAt = now + RespawnMs;
        attacker.Score += KillPoints;
        Scores[attackerId] = attacker.Score;
        events.Add(("ArenaKill", new object?[] { attackerId, victimId }));
    }

    private static async Task Loop(IHubContext<GameHub> hub)
    {
        var last = Environment.TickCount64;
        while (true)
        {
            await Task.Delay(50);
            var now = Environment.TickCount64;
            var dt = (now - last) / 1000f;
            last = now;
            var events = new List<(string Method, object?[] Args)>();
            var respawned = new List<string>();
            bool changed = false;
            lock (Gate)
            {
                if (InArena.Count == 0) { _loopRunning = false; Arrows.Clear(); return; }

                foreach (var (id, st) in InArena)
                    if (!st.Alive && now >= st.RespawnAt)
                    {
                        st.Alive = true; st.Hp = MaxHp; st.ImmuneUntil = now + ImmuneMs;
                        if (GameHub.Players.TryGetValue(id, out var p)) { p.X = EntryX; p.Y = SpawnY; respawned.Add(id); }
                        changed = true;
                    }

                for (var i = Arrows.Count - 1; i >= 0; i--)
                {
                    var a = Arrows[i];
                    var step = ArrowSpeed * dt;
                    a.X += a.Dir * step; a.Traveled += step;
                    var hit = false;
                    if (InArena.TryGetValue(a.Owner, out var owner))
                        foreach (var (vid, vst) in InArena)
                        {
                            if (vid == a.Owner || !vst.Alive || vst.ImmuneUntil > now || !GameHub.Players.TryGetValue(vid, out var v)) continue;
                            if (Math.Abs(v.X - a.X) > ArrowHitX || Math.Abs(v.Y - a.Y) > ArrowHitY) continue;
                            Damage(a.Owner, owner, vid, vst, Weapons[2], (int)a.Dir, a.Id, now, events);
                            hit = true; changed = true;
                            break;
                        }
                    if (hit || a.Traveled >= ArrowRange || a.X < 0 || a.X > 1280 || owner is null) Arrows.RemoveAt(i);
                }
            }

            foreach (var (m, a) in events) await Send(hub, m, a);
            foreach (var id in respawned)
                if (GameHub.Players.TryGetValue(id, out var p)) await Send(hub, "PlayerMap", id, MapName, p.X, p.Y);
            if (changed) await BroadcastState(hub);
        }
    }
}
