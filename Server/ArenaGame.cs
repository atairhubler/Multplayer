using Microsoft.AspNetCore.SignalR;

// Combate: a arena (jogador contra jogador) e a floresta (jogadores juntos contra slimes; um não machuca o outro).
// Cada jogador tem vida, escolhe uma arma e ganha pontos. O servidor decide tudo (alcance, recarga, dano, flechas,
// movimento e ataque dos slimes); os clientes só desenham os efeitos. Estado só em memória.
public static class ArenaGame
{
    public const string MapName = "arena", ForestMap = "forest";
    public const float EntryX = 80, VillageHomeX = 640, SpawnY = 540; // y do centro do boneco; ele cai até a calçada
    private const int MaxHp = 100, RespawnMs = 3000, ImmuneMs = 2000, KillPoints = 10, HitPoints = 1;
    private const float HalfBody = 22, ReachY = 60;
    private const float ArrowSpeed = 600, ArrowRange = 650, ArrowHitX = 26, ArrowHitY = 50; // px/s e px

    // Slimes da floresta
    // Largura de cada mapa (a floresta é grande e a câmera acompanha o jogador). ATENÇÃO: ForestW é o mesmo valor de FOREST_W no game.js
    public const float ForestW = 5815;
    public static float MapWidth(string map) => map == ForestMap ? ForestW : 1280;
    private const int SlimeCount = 22 /* ~5 por tela */, SlimeHp = 30, SlimeKillPoints = 5, SlimeRespawnMs = 6000, SlimeContactDamage = 18, SlimeContactImmuneMs = 1500;
    private const float SlimeSpeed = 95, SlimeGroundY = 580, SlimeMinX = 250, SlimeMaxX = ForestW - 450, SlimeSight = 380, SlimeHopMax = 26;
    private const double SlimeHopSeconds = 1.0, SlimeAirFraction = 0.4;
    // Evolução: cada jogador que o slime derrota dobra o tamanho, a vida e o dano dele, até 10x o de um slime normal (1x, 2x, 4x, 8x, 10x)
    private static readonly float[] SlimeMults = { 1, 2, 4, 8, 10 };
    private const float SlimeHalfW = 20, SlimeHalfH = 14; // meio corpo de um slime normal (px)
    public const string ForestGroup = "forest";

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

    private class State { public int Hp = MaxHp, Weapon, Score; public long LastAttackAt, ImmuneUntil, RespawnAt; public bool Alive = true; public string Map = MapName; }
    private class Arrow { public int Id; public string Owner = "", Map = MapName; public float X, Y, Dir, Traveled; }
    private class Slime { public int Id, Level, MaxHp = SlimeHp; public float X, Hop, Mult = 1; public int Hp = SlimeHp, Dir = 1; public double Phase; public long NextTurnAt, RespawnAt; public bool Alive; }
    private static float SlimeCenterY(Slime s) => 594 - SlimeHalfH * s.Mult - s.Hop; // y do centro do corpo (o chão fica em 594)

    // Moedas que caem dos slimes derrotados: ficam no chão por um tempo e quem encostar primeiro leva
    private class Coin { public int Id, Value; public float X; public long ExpireAt; }
    private const int CoinLifeMs = 45_000, MaxCoinsOnGround = 120;
    private const float CoinPickupX = 42, CoinPickupY = 95; // alcance (px) em torno do jogador
    private static readonly List<Coin> Coins = new();
    private static int _nextCoin;
    private static object CoinSnapshot() => Coins.Select(c => new { id = c.Id, x = c.X, v = c.Value }).ToList();

    // Quanto e quantas moedas um slime solta: 3 × o tamanho no total (3 no slime normal, 30 no de 10x), em 2 a 8 moedas
    private static void DropCoins(Slime sl, long now, List<(string, object?[])> events)
    {
        var total = Math.Max(3, (int)(3 * sl.Mult));
        var n = Math.Min(8, 2 + sl.Level * 2);
        var dropped = new List<object>();
        for (var i = 0; i < n; i++)
        {
            var value = total / n + (i < total % n ? 1 : 0);
            if (value <= 0) continue;
            var c = new Coin { Id = ++_nextCoin, Value = value, X = Math.Clamp(sl.X + (float)(Rng.NextDouble() * 120 - 60), 40, ForestW - 40), ExpireAt = now + CoinLifeMs };
            Coins.Add(c);
            dropped.Add(new { id = c.Id, x = c.X, v = c.Value, from = sl.X });
        }
        while (Coins.Count > MaxCoinsOnGround) Coins.RemoveAt(0);
        events.Add(("CoinsDropped", new object?[] { dropped }));
    }

    private static readonly object Gate = new();
    private static readonly Dictionary<string, State> InCombat = new();
    private static readonly Dictionary<string, int> Scores = new(); // a pontuação fica enquanto o jogador estiver conectado
    private static readonly List<Arrow> Arrows = new();
    private static readonly List<Slime> Slimes = new();
    private static readonly Random Rng = new();
    private static int _nextArrow;
    private static bool _loopRunning;

    public static bool IsCombatMap(string map) => map == MapName || map == ForestMap;

    // Poção de vida: só faz efeito em quem está em combate (arena/floresta), vivo e com a vida abaixo do máximo
    public static bool CanHeal(string id)
    {
        lock (Gate) return InCombat.TryGetValue(id, out var st) && st.Alive && st.Hp < MaxHp;
    }

    public static async Task<bool> HealAsync(IHubContext<GameHub> hub, string id, int amount)
    {
        lock (Gate)
        {
            if (!InCombat.TryGetValue(id, out var st) || !st.Alive || st.Hp >= MaxHp) return false;
            st.Hp = Math.Min(MaxHp, st.Hp + amount);
        }
        await BroadcastState(hub);
        return true;
    }

    private static Task Send(IHubContext<GameHub> hub, string method, params object?[] args) =>
        hub.Clients.Group(GameHub.Room).SendCoreAsync(method, args); // SendCoreAsync: cada item de args vira um argumento do cliente

    // Lista para o ranking e as barras de vida (arena e floresta; o cliente filtra pelo mapa)
    public static object Snapshot()
    {
        lock (Gate)
            return InCombat
                .Where(kv => GameHub.Players.ContainsKey(kv.Key))
                .Select(kv => new { id = kv.Key, name = GameHub.Players[kv.Key].Name, hp = kv.Value.Hp, score = kv.Value.Score, weapon = kv.Value.Weapon, alive = kv.Value.Alive, map = kv.Value.Map })
                .OrderByDescending(p => p.score).ThenBy(p => p.name)
                .ToList();
    }

    private static Task BroadcastState(IHubContext<GameHub> hub) => Send(hub, "ArenaState", Snapshot());

    // Slimes vivos (posição do centro; y já inclui o pulo)
    private static object SlimeSnapshot() => Slimes.Where(s => s.Alive)
        .Select(s => new { id = "slime:" + s.Id, x = s.X, y = SlimeCenterY(s), hp = s.Hp, max = s.MaxHp, dir = s.Dir, hop = s.Hop, lvl = s.Level, mult = s.Mult })
        .ToList();

    public static async Task Enter(IHubContext<GameHub> hub, string id, string map)
    {
        lock (Gate)
        {
            InCombat[id] = new State { Score = Scores.GetValueOrDefault(id), Weapon = InCombat.TryGetValue(id, out var old) ? old.Weapon : 0, ImmuneUntil = Environment.TickCount64 + ImmuneMs, Map = map };
            if (map == ForestMap && Slimes.Count == 0)
                for (var i = 1; i <= SlimeCount; i++) Slimes.Add(NewSlime(i));
            if (!_loopRunning) { _loopRunning = true; _ = Task.Run(() => Loop(hub)); }
        }
        if (map == ForestMap)
        {
            await hub.Groups.AddToGroupAsync(id, ForestGroup);
            object snap, coinSnap; lock (Gate) { snap = SlimeSnapshot(); coinSnap = CoinSnapshot(); }
            await hub.Clients.Client(id).SendAsync("SlimeState", snap);
            await hub.Clients.Client(id).SendAsync("CoinState", coinSnap);
        }
        await BroadcastState(hub);
    }

    private static Slime NewSlime(int id) => new()
    {
        Id = id, Alive = true, Hp = SlimeHp, X = SlimeMinX + (float)Rng.NextDouble() * (SlimeMaxX - SlimeMinX),
        Dir = Rng.Next(2) == 0 ? -1 : 1, Phase = Rng.NextDouble(), NextTurnAt = Environment.TickCount64 + Rng.Next(1500, 3500),
    };

    public static async Task Leave(IHubContext<GameHub> hub, string id)
    {
        bool had;
        lock (Gate) { had = InCombat.Remove(id); Arrows.RemoveAll(a => a.Owner == id); }
        await hub.Groups.RemoveFromGroupAsync(id, ForestGroup);
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
            if (!InCombat.TryGetValue(id, out var st) || st.Weapon == weapon) return;
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
            if (!InCombat.TryGetValue(me.Id, out var st) || !st.Alive) return;
            var now = Environment.TickCount64;
            var w = Weapons[st.Weapon];
            if (now - st.LastAttackAt < w.CooldownMs) return;
            st.LastAttackAt = now;
            events.Add(("ArenaSwing", new object?[] { me.Id, st.Weapon, dir }));

            if (w.Projectile)
            {
                var arrow = new Arrow { Id = ++_nextArrow, Owner = me.Id, Map = st.Map, X = me.X + dir * 24, Y = me.Y - 6, Dir = dir };
                Arrows.Add(arrow);
                events.Add(("ArrowFired", new object?[] { arrow.Id, me.Id, arrow.X, arrow.Y, dir }));
            }
            else if (st.Map == MapName)
            {
                // arena: jogador contra jogador
                foreach (var (vid, vst) in InCombat.ToList())
                {
                    if (vid == me.Id || vst.Map != MapName || !vst.Alive || vst.ImmuneUntil > now || !GameHub.Players.TryGetValue(vid, out var v)) continue;
                    var dx = (v.X - me.X) * dir;
                    if (dx < -10 || dx > w.Range + HalfBody || Math.Abs(v.Y - me.Y) > ReachY) continue;
                    Damage(me.Id, st, vid, vst, w, dir, 0, now, events);
                    stateChanged = true;
                }
            }
            else
            {
                // floresta: só os slimes apanham (jogadores não se machucam)
                foreach (var sl in Slimes)
                {
                    if (!sl.Alive) continue;
                    var dx = (sl.X - me.X) * dir;
                    if (dx < -10 || dx > w.Range + HalfBody + SlimeHalfW * sl.Mult || Math.Abs(SlimeCenterY(sl) - me.Y) > ReachY + 10 + SlimeHalfH * sl.Mult) continue;
                    HitSlime(me.Id, st, sl, w, dir, 0, now, events);
                    stateChanged = true;
                }
            }
        }
        foreach (var (m, a) in events) await Send(hub, m, a);
        if (stateChanged) await BroadcastState(hub);
    }

    // Aplica o dano em um jogador (dentro do lock): pontos, abate e eventos
    private static void Damage(string attackerId, State attacker, string victimId, State victim, Weapon w, int dir, int arrowId, long now, List<(string, object?[])> events)
    {
        victim.Hp = Math.Max(0, victim.Hp - w.Damage);
        attacker.Score += HitPoints;
        Progress.Add(attackerId, points: HitPoints);
        events.Add(("ArenaHit", new object?[] { attackerId, victimId, w.Damage, victim.Hp, dir, w.Knock, w.Lift, arrowId }));
        if (victim.Hp > 0) { Scores[attackerId] = attacker.Score; return; }
        victim.Alive = false;
        victim.RespawnAt = now + RespawnMs;
        attacker.Score += KillPoints;
        Progress.Add(attackerId, points: KillPoints, playerKills: 1);
        Progress.Add(victimId, deaths: 1);
        Scores[attackerId] = attacker.Score;
        events.Add(("ArenaKill", new object?[] { attackerId, victimId }));
    }

    // O slime derrotou um jogador: dobra tamanho, vida e dano (até 10x) e muda de cor (nível novo no cliente)
    private static void EvolveSlime(Slime sl, string victimName, List<(string, object?[])> events)
    {
        if (sl.Level >= SlimeMults.Length - 1) return;
        var old = sl.Mult;
        sl.Level++;
        sl.Mult = SlimeMults[sl.Level];
        sl.MaxHp = (int)(SlimeHp * sl.Mult);
        sl.Hp = Math.Min(sl.MaxHp, (int)Math.Round(sl.Hp * (sl.Mult / old)));
        var msg = sl.Level == SlimeMults.Length - 1
            ? $"👑 Um slime derrotou {victimName} e chegou ao tamanho máximo ({sl.Mult:0}x)! Cuidado!"
            : $"🟢 Um slime derrotou {victimName} e evoluiu para {sl.Mult:0}x!";
        events.Add(("SystemMessage", new object?[] { msg }));
    }

    // Aplica o dano em um slime (dentro do lock)
    private static void HitSlime(string attackerId, State attacker, Slime sl, Weapon w, int dir, int arrowId, long now, List<(string, object?[])> events)
    {
        sl.Hp = Math.Max(0, sl.Hp - w.Damage);
        sl.X = Math.Clamp(sl.X + dir * w.Knock * 0.08f, 60, ForestW - 60);
        attacker.Score += HitPoints;
        Progress.Add(attackerId, points: HitPoints);
        var slimeId = "slime:" + sl.Id;
        events.Add(("ArenaHit", new object?[] { attackerId, slimeId, w.Damage, sl.Hp, dir, w.Knock, w.Lift, arrowId }));
        if (sl.Hp <= 0)
        {
            sl.Alive = false;
            sl.RespawnAt = now + SlimeRespawnMs;
            attacker.Score += (int)(SlimeKillPoints * sl.Mult); // slime evoluído vale mais
            Progress.Add(attackerId, points: (int)(SlimeKillPoints * sl.Mult), slimeKills: 1);
            events.Add(("ArenaKill", new object?[] { attackerId, slimeId, sl.Level }));
            DropCoins(sl, now, events);
        }
        Scores[attackerId] = attacker.Score;
    }

    private static async Task Loop(IHubContext<GameHub> hub)
    {
        var last = Environment.TickCount64;
        long lastSlimeSend = 0;
        while (true)
        {
            await Task.Delay(50);
            var now = Environment.TickCount64;
            var dt = (now - last) / 1000f;
            last = now;
            var events = new List<(string Method, object?[] Args)>();
            var respawned = new List<string>();
            var sentHome = new List<string>(); // quem caiu na floresta volta para a cidade principal
            object? slimeSnap = null;
            bool changed = false;
            lock (Gate)
            {
                // sem ninguém em combate o laço para; os slimes (e a evolução deles) ficam guardados para quando alguém voltar à floresta
                if (InCombat.Count == 0) { _loopRunning = false; Arrows.Clear(); return; }

                // jogadores caídos voltam
                foreach (var (id, st) in InCombat)
                    if (!st.Alive && now >= st.RespawnAt)
                    {
                        st.Alive = true; st.Hp = MaxHp; st.ImmuneUntil = now + ImmuneMs;
                        if (st.Map == ForestMap) sentHome.Add(id);
                        else if (GameHub.Players.TryGetValue(id, out var p)) { p.X = EntryX; p.Y = SpawnY; respawned.Add(id); }
                        changed = true;
                    }
                foreach (var id in sentHome)
                {
                    InCombat.Remove(id);
                    Arrows.RemoveAll(a => a.Owner == id);
                    if (GameHub.Players.TryGetValue(id, out var home)) { home.Map = "village"; home.X = VillageHomeX; home.Y = SpawnY; }
                }
                if (InCombat.Count == 0) { _loopRunning = false; Arrows.Clear(); }

                // flechas
                for (var i = Arrows.Count - 1; i >= 0; i--)
                {
                    var a = Arrows[i];
                    var step = ArrowSpeed * dt;
                    a.X += a.Dir * step; a.Traveled += step;
                    var hit = false;
                    if (InCombat.TryGetValue(a.Owner, out var owner))
                    {
                        if (a.Map == MapName)
                        {
                            foreach (var (vid, vst) in InCombat)
                            {
                                if (vid == a.Owner || vst.Map != MapName || !vst.Alive || vst.ImmuneUntil > now || !GameHub.Players.TryGetValue(vid, out var v)) continue;
                                if (Math.Abs(v.X - a.X) > ArrowHitX || Math.Abs(v.Y - a.Y) > ArrowHitY) continue;
                                Damage(a.Owner, owner, vid, vst, Weapons[2], (int)a.Dir, a.Id, now, events);
                                hit = true; changed = true;
                                break;
                            }
                        }
                        else
                        {
                            foreach (var sl in Slimes)
                            {
                                if (!sl.Alive || Math.Abs(sl.X - a.X) > ArrowHitX + 10 + SlimeHalfW * sl.Mult || Math.Abs(SlimeCenterY(sl) - a.Y) > ArrowHitY + SlimeHalfH * sl.Mult) continue;
                                HitSlime(a.Owner, owner, sl, Weapons[2], (int)a.Dir, a.Id, now, events);
                                hit = true; changed = true;
                                break;
                            }
                        }
                    }
                    if (hit || a.Traveled >= ArrowRange || a.X < 0 || a.X > MapWidth(a.Map) || owner is null) Arrows.RemoveAt(i);
                }

                // slimes: só existem enquanto houver alguém na floresta
                var forest = InCombat.Where(kv => kv.Value.Map == ForestMap && GameHub.Players.ContainsKey(kv.Key)).ToList();
                if (forest.Count > 0)
                {
                    foreach (var sl in Slimes)
                    {
                        if (!sl.Alive)
                        {
                            if (now >= sl.RespawnAt) { var n = NewSlime(sl.Id); sl.Alive = true; sl.Hp = n.Hp; sl.MaxHp = SlimeHp; sl.Level = 0; sl.Mult = 1; sl.X = n.X; sl.Dir = n.Dir; sl.Phase = 0; sl.Hop = 0; }
                            continue;
                        }
                        var prevPhase = sl.Phase;
                        sl.Phase += dt / SlimeHopSeconds;
                        var newHop = sl.Phase >= 1.0;
                        if (newHop) sl.Phase -= 1.0;
                        if (newHop)
                        {
                            // a cada pulo: persegue o jogador mais próximo que estiver à vista; senão passeia
                            var target = forest.Where(kv => kv.Value.Alive).Select(kv => GameHub.Players[kv.Key])
                                .Where(p => Math.Abs(p.X - sl.X) < SlimeSight).OrderBy(p => Math.Abs(p.X - sl.X)).FirstOrDefault();
                            if (target is not null) sl.Dir = target.X >= sl.X ? 1 : -1;
                            else if (now >= sl.NextTurnAt) { sl.Dir = Rng.Next(2) == 0 ? -1 : 1; sl.NextTurnAt = now + Rng.Next(1500, 3500); }
                        }
                        if (sl.Phase < SlimeAirFraction)
                        {
                            sl.X += sl.Dir * SlimeSpeed * dt;
                            sl.Hop = SlimeHopMax * (float)Math.Sqrt(sl.Mult) * (float)Math.Sin(Math.PI * sl.Phase / SlimeAirFraction);
                        }
                        else sl.Hop = 0;
                        if (sl.X < SlimeMinX - 90) { sl.X = SlimeMinX - 90; sl.Dir = 1; }
                        if (sl.X > SlimeMaxX + 70) { sl.X = SlimeMaxX + 70; sl.Dir = -1; }
                        var centerY = SlimeCenterY(sl);

                        // encostou em um jogador: dano e empurrão
                        foreach (var (pid, pst) in forest)
                        {
                            if (!pst.Alive || pst.ImmuneUntil > now || !GameHub.Players.TryGetValue(pid, out var p)) continue;
                            if (Math.Abs(p.X - sl.X) > 22 + SlimeHalfW * sl.Mult * 0.85f || Math.Abs(p.Y - centerY) > 33 + SlimeHalfH * sl.Mult) continue;
                            var dmg = (int)Math.Round(SlimeContactDamage * sl.Mult); // o dano cresce junto com o slime
                            pst.Hp = Math.Max(0, pst.Hp - dmg);
                            pst.ImmuneUntil = now + SlimeContactImmuneMs;
                            var away = p.X >= sl.X ? 1 : -1;
                            events.Add(("ArenaHit", new object?[] { "slime:" + sl.Id, pid, dmg, pst.Hp, away, 260f + 40f * sl.Mult, 140f, 0 }));
                            changed = true;
                            if (pst.Hp <= 0)
                            {
                                pst.Alive = false; pst.RespawnAt = now + RespawnMs;
                                Progress.Add(pid, deaths: 1);
                                events.Add(("ArenaKill", new object?[] { "slime:" + sl.Id, pid, sl.Level }));
                                EvolveSlime(sl, GameHub.Players[pid].Name, events); // matou um jogador: evolui
                            }
                        }
                    }
                    if (now - lastSlimeSend >= 100) { lastSlimeSend = now; slimeSnap = SlimeSnapshot(); }

                    // moedas: quem encostar leva; as que ninguém pegou somem depois de 45 s
                    for (var i = Coins.Count - 1; i >= 0; i--)
                    {
                        var coin = Coins[i];
                        if (now >= coin.ExpireAt) { events.Add(("CoinTaken", new object?[] { coin.Id, null, 0 })); Coins.RemoveAt(i); continue; }
                        foreach (var (pid, pst) in forest)
                        {
                            if (!pst.Alive || !GameHub.Players.TryGetValue(pid, out var p)) continue;
                            if (Math.Abs(p.X - coin.X) > CoinPickupX || Math.Abs(p.Y - 560) > CoinPickupY) continue;
                            Progress.Add(pid, coins: coin.Value);
                            events.Add(("CoinTaken", new object?[] { coin.Id, pid, coin.Value }));
                            Coins.RemoveAt(i);
                            break;
                        }
                    }
                }
            }

            foreach (var (m, a) in events)
            {
                if (m is "SystemMessage" or "CoinsDropped" or "CoinTaken") await hub.Clients.Group(ForestGroup).SendCoreAsync(m, a); // só quem está na floresta
                else await Send(hub, m, a);
            }
            foreach (var id in sentHome)
            {
                await hub.Groups.RemoveFromGroupAsync(id, ForestGroup);
                if (GameHub.Players.TryGetValue(id, out var home)) await Send(hub, "PlayerMap", id, "village", home.X, home.Y);
            }
            foreach (var id in respawned)
                if (GameHub.Players.TryGetValue(id, out var p)) await Send(hub, "PlayerMap", id, GameHub.Players[id].Map, p.X, p.Y);
            if (slimeSnap is not null) await hub.Clients.Group(ForestGroup).SendAsync("SlimeState", slimeSnap);
            if (changed) await BroadcastState(hub);
        }
    }
}
