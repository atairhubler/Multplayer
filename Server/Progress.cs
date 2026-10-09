using System.Collections.Concurrent;

// Progresso das contas (só de quem entrou com o Google): pontos e estatísticas de combate, títulos e perfil.
// Os números vão se acumulando na memória (rápido, sem travar o jogo) e são gravados no banco a cada 30 s e quando o jogador sai.
public static class Progress
{
    private sealed class Delta { public long Points, Coins; public int PlayerKills, SlimeKills, Deaths; }

    private static readonly ConcurrentDictionary<long, Delta> Pending = new();
    private static Db? _db;

    public static void Init(Db db)
    {
        _db = db;
        if (db.Enabled) _ = Task.Run(FlushLoop);
    }

    private static bool TryAccount(string connectionId, out long accountId)
    {
        accountId = 0;
        if (_db is null || !_db.Enabled) return false;
        if (!GameHub.Players.TryGetValue(connectionId, out var p) || p.AccountId is not long id) return false;
        accountId = id;
        return true;
    }

    // Soma ao progresso da conta ligada a esta conexão (se não houver conta, não faz nada)
    public static void Add(string connectionId, int points = 0, int playerKills = 0, int slimeKills = 0, int deaths = 0, int coins = 0)
    {
        if (!TryAccount(connectionId, out var id)) return;
        var d = Pending.GetOrAdd(id, _ => new Delta());
        if (coins != 0) Interlocked.Add(ref d.Coins, coins);
        if (points != 0) Interlocked.Add(ref d.Points, points);
        if (playerKills != 0) Interlocked.Add(ref d.PlayerKills, playerKills);
        if (slimeKills != 0) Interlocked.Add(ref d.SlimeKills, slimeKills);
        if (deaths != 0) Interlocked.Add(ref d.Deaths, deaths);
    }

    // Ainda não gravado no banco (para mostrar valores atualizados no /perfil)
    public static AccountStats PendingFor(long accountId) =>
        Pending.TryGetValue(accountId, out var d) ? new AccountStats(Interlocked.Read(ref d.Points), d.PlayerKills, d.SlimeKills, d.Deaths, Interlocked.Read(ref d.Coins)) : new AccountStats(0, 0, 0, 0, 0);

    // Guarda a aparência (só bonecos "char:") da conta ligada a esta conexão
    public static void SaveCharacter(string connectionId, string character)
    {
        if (!TryAccount(connectionId, out var id)) return;
        _ = Task.Run(async () => { try { await _db!.SaveCharacterAsync(id, character); } catch (Exception e) { Console.WriteLine("[db] aparência não salva: " + e.GetType().Name); } });
    }

    public static void SaveTitle(string connectionId, string title)
    {
        if (!TryAccount(connectionId, out var id)) return;
        _ = Task.Run(async () => { try { await _db!.AddTitleAsync(id, title); } catch (Exception e) { Console.WriteLine("[db] título não salvo: " + e.GetType().Name); } });
    }

    public static void SaveProfile(string connectionId, string? nameColor, string? title)
    {
        if (!TryAccount(connectionId, out var id)) return;
        _ = Task.Run(async () => { try { await _db!.SaveProfileAsync(id, nameColor, title); } catch (Exception e) { Console.WriteLine("[db] perfil não salvo: " + e.GetType().Name); } });
    }

    // Grava o que está pendente (de uma conta, ou de todas). Se o banco falhar, devolve os números para tentar de novo depois.
    public static async Task FlushAsync(long? onlyAccount = null)
    {
        if (_db is null || !_db.Enabled) return;
        foreach (var (id, d) in Pending)
        {
            if (onlyAccount is long only && only != id) continue;
            var pts = Interlocked.Exchange(ref d.Points, 0);
            var pk = Interlocked.Exchange(ref d.PlayerKills, 0);
            var sk = Interlocked.Exchange(ref d.SlimeKills, 0);
            var dt = Interlocked.Exchange(ref d.Deaths, 0);
            var coins = Interlocked.Exchange(ref d.Coins, 0);
            if (pts == 0 && pk == 0 && sk == 0 && dt == 0 && coins == 0) continue;
            try { await _db.AddStatsAsync(id, pts, pk, sk, dt, coins); }
            catch (Exception e)
            {
                Interlocked.Add(ref d.Points, pts); Interlocked.Add(ref d.PlayerKills, pk); Interlocked.Add(ref d.SlimeKills, sk); Interlocked.Add(ref d.Deaths, dt); Interlocked.Add(ref d.Coins, coins);
                Console.WriteLine("[db] progresso não gravado (tentarei de novo): " + e.GetType().Name);
            }
        }
    }

    private static async Task FlushLoop()
    {
        while (true)
        {
            await Task.Delay(TimeSpan.FromSeconds(30));
            try { await FlushAsync(); } catch (Exception e) { Console.WriteLine("[db] falha ao gravar o progresso: " + e.GetType().Name); }
        }
    }
}
