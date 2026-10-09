using System.Diagnostics;
using Npgsql;

// Banco de dados (Postgres na Neon). A conexão vem da variável de ambiente DATABASE_URL (no Render, em Environment);
// sem ela o jogo funciona normalmente, só que sem guardar nada. A senha nunca vai para o código nem para o repositório.
public sealed class Db
{
    private readonly NpgsqlDataSource? _source;
    public bool Enabled => _source is not null;

    public Db()
    {
        var url = Environment.GetEnvironmentVariable("DATABASE_URL");
        if (string.IsNullOrWhiteSpace(url)) return;
        try { _source = NpgsqlDataSource.Create(BuildConnectionString(url)); }
        catch (Exception e) { Console.WriteLine("[db] DATABASE_URL inválida: " + e.GetType().Name); }
    }

    // Converte postgresql://usuario:senha@host/banco?sslmode=require na string de conexão do Npgsql
    private static string BuildConnectionString(string url)
    {
        var uri = new Uri(url);
        var user = uri.UserInfo.Split(':', 2);
        return new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Username = Uri.UnescapeDataString(user[0]),
            Password = user.Length > 1 ? Uri.UnescapeDataString(user[1]) : "",
            Database = uri.AbsolutePath.Trim('/'),
            SslMode = SslMode.Require,   // a Neon exige conexão criptografada
            Timeout = 30,                // o banco "dorme" após 5 min parado e leva alguns segundos para acordar
            CommandTimeout = 20,
            MaxPoolSize = 10,
        }.ConnectionString;
    }

    public NpgsqlDataSource Source => _source ?? throw new InvalidOperationException("Banco de dados não configurado (DATABASE_URL).");

    // Cria as tabelas que ainda não existem. Cada passo é idempotente (IF NOT EXISTS): pode rodar a cada início.
    public async Task EnsureSchemaAsync()
    {
        if (_source is null) return;
        await using var cmd = _source.CreateCommand("""
            CREATE TABLE IF NOT EXISTS app_meta (
                key        text PRIMARY KEY,
                value      text NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now()
            );
            INSERT INTO app_meta (key, value) VALUES ('schema_version', '1')
            ON CONFLICT (key) DO NOTHING;

            -- contas (uma por usuário do Google; google_sub é o identificador estável dele)
            CREATE TABLE IF NOT EXISTS accounts (
                id            bigserial PRIMARY KEY,
                google_sub    text NOT NULL UNIQUE,
                email         text,
                display_name  text NOT NULL,
                picture       text,
                created_at    timestamptz NOT NULL DEFAULT now(),
                last_login_at timestamptz NOT NULL DEFAULT now()
            );

            -- estatísticas de combate (somadas de todas as sessões)
            CREATE TABLE IF NOT EXISTS account_stats (
                account_id   bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                points       bigint NOT NULL DEFAULT 0,
                player_kills integer NOT NULL DEFAULT 0,
                slime_kills  integer NOT NULL DEFAULT 0,
                deaths       integer NOT NULL DEFAULT 0,
                updated_at   timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS account_stats_points_idx ON account_stats (points DESC);

            -- títulos conquistados
            CREATE TABLE IF NOT EXISTS account_titles (
                account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                title      text NOT NULL,
                earned_at  timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (account_id, title)
            );

            -- preferências: cor do nome e título equipado
            CREATE TABLE IF NOT EXISTS account_profile (
                account_id     bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                name_color     text,
                equipped_title text,
                updated_at     timestamptz NOT NULL DEFAULT now()
            );

            -- colunas acrescentadas depois (rodar de novo não faz mal)
            ALTER TABLE account_stats ADD COLUMN IF NOT EXISTS coins bigint NOT NULL DEFAULT 0;   -- moedas (drops dos slimes)
            ALTER TABLE account_profile ADD COLUMN IF NOT EXISTS character text;                    -- aparência do boneco (char:m|f:cabelo:pele:roupa)
            ALTER TABLE account_profile ADD COLUMN IF NOT EXISTS active_potion text;                -- poção do botão rápido (life|mana|stamina)

            -- inventário: quantidade de cada item que a conta possui
            CREATE TABLE IF NOT EXISTS account_items (
                account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                item       text NOT NULL,
                qty        integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
                PRIMARY KEY (account_id, item)
            );
            """);
        await cmd.ExecuteNonQueryAsync();
    }

    // Cria a conta no primeiro login e atualiza nome/foto/último acesso nos seguintes
    public async Task<Account> UpsertAccountAsync(string googleSub, string? email, string name, string? picture)
    {
        name = name.Length > 40 ? name[..40] : name;
        await using var cmd = Source.CreateCommand("""
            INSERT INTO accounts (google_sub, email, display_name, picture)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (google_sub) DO UPDATE
                SET email = EXCLUDED.email, picture = EXCLUDED.picture, last_login_at = now()
            RETURNING id, display_name, picture
            """);
        cmd.Parameters.AddWithValue(googleSub);
        cmd.Parameters.AddWithValue((object?)email ?? DBNull.Value);
        cmd.Parameters.AddWithValue(name);
        cmd.Parameters.AddWithValue((object?)picture ?? DBNull.Value);
        await using var r = await cmd.ExecuteReaderAsync();
        await r.ReadAsync();
        return new Account(r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2));
    }

    public async Task AddStatsAsync(long accountId, long points, int playerKills, int slimeKills, int deaths, long coins)
    {
        await using var cmd = Source.CreateCommand("""
            INSERT INTO account_stats (account_id, points, player_kills, slime_kills, deaths, coins)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (account_id) DO UPDATE
                SET points = account_stats.points + EXCLUDED.points,
                    player_kills = account_stats.player_kills + EXCLUDED.player_kills,
                    slime_kills = account_stats.slime_kills + EXCLUDED.slime_kills,
                    deaths = account_stats.deaths + EXCLUDED.deaths,
                    coins = account_stats.coins + EXCLUDED.coins,
                    updated_at = now()
            """);
        cmd.Parameters.AddWithValue(accountId);
        cmd.Parameters.AddWithValue(points);
        cmd.Parameters.AddWithValue(playerKills);
        cmd.Parameters.AddWithValue(slimeKills);
        cmd.Parameters.AddWithValue(deaths);
        cmd.Parameters.AddWithValue(coins);
        await cmd.ExecuteNonQueryAsync();
    }

    // Guarda a aparência do boneco (só bonecos "char:", nunca imagens/GIFs) sem mexer na cor do nome nem no título
    public async Task SaveCharacterAsync(long accountId, string character)
    {
        await using var cmd = Source.CreateCommand("""
            INSERT INTO account_profile (account_id, character) VALUES ($1, $2)
            ON CONFLICT (account_id) DO UPDATE SET character = EXCLUDED.character, updated_at = now()
            """);
        cmd.Parameters.AddWithValue(accountId);
        cmd.Parameters.AddWithValue(character);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task AddTitleAsync(long accountId, string title)
    {
        await using var cmd = Source.CreateCommand("INSERT INTO account_titles (account_id, title) VALUES ($1, $2) ON CONFLICT DO NOTHING");
        cmd.Parameters.AddWithValue(accountId);
        cmd.Parameters.AddWithValue(title);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task SaveProfileAsync(long accountId, string? nameColor, string? title)
    {
        await using var cmd = Source.CreateCommand("""
            INSERT INTO account_profile (account_id, name_color, equipped_title) VALUES ($1, $2, $3)
            ON CONFLICT (account_id) DO UPDATE SET name_color = EXCLUDED.name_color, equipped_title = EXCLUDED.equipped_title, updated_at = now()
            """);
        cmd.Parameters.AddWithValue(accountId);
        cmd.Parameters.AddWithValue((object?)nameColor ?? DBNull.Value);
        cmd.Parameters.AddWithValue((object?)title ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<AccountData> LoadAccountDataAsync(long accountId)
    {
        var stats = new AccountStats(0, 0, 0, 0, 0);
        var titles = new List<string>();
        string? color = null, equipped = null, character = null, activePotion = null;
        var items = new Dictionary<string, int>();
        await using (var cmd = Source.CreateCommand("SELECT points, player_kills, slime_kills, deaths, coins FROM account_stats WHERE account_id = $1"))
        {
            cmd.Parameters.AddWithValue(accountId);
            await using var r = await cmd.ExecuteReaderAsync();
            if (await r.ReadAsync()) stats = new AccountStats(r.GetInt64(0), r.GetInt32(1), r.GetInt32(2), r.GetInt32(3), r.GetInt64(4));
        }
        await using (var cmd = Source.CreateCommand("SELECT title FROM account_titles WHERE account_id = $1 ORDER BY earned_at"))
        {
            cmd.Parameters.AddWithValue(accountId);
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync()) titles.Add(r.GetString(0));
        }
        await using (var cmd = Source.CreateCommand("SELECT name_color, equipped_title, character, active_potion FROM account_profile WHERE account_id = $1"))
        {
            cmd.Parameters.AddWithValue(accountId);
            await using var r = await cmd.ExecuteReaderAsync();
            if (await r.ReadAsync())
            {
                color = r.IsDBNull(0) ? null : r.GetString(0);
                equipped = r.IsDBNull(1) ? null : r.GetString(1);
                character = r.IsDBNull(2) ? null : r.GetString(2);
                activePotion = r.IsDBNull(3) ? null : r.GetString(3);
            }
        }
        await using (var cmd = Source.CreateCommand("SELECT item, qty FROM account_items WHERE account_id = $1 AND qty > 0"))
        {
            cmd.Parameters.AddWithValue(accountId);
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync()) items[r.GetString(0)] = r.GetInt32(1);
        }
        return new AccountData(stats, titles, color, equipped, character, items, activePotion);
    }

    // Compra: debita as moedas e soma o item NA MESMA transação (ou nada acontece). Devolve null se faltar moeda.
    public async Task<(long Coins, int Qty)?> BuyItemAsync(long accountId, string item, int price)
    {
        await using var conn = await Source.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        long coins;
        await using (var cmd = new Npgsql.NpgsqlCommand("UPDATE account_stats SET coins = coins - $2, updated_at = now() WHERE account_id = $1 AND coins >= $2 RETURNING coins", conn, tx))
        {
            cmd.Parameters.AddWithValue(accountId);
            cmd.Parameters.AddWithValue((long)price);
            var res = await cmd.ExecuteScalarAsync();
            if (res is null) return null; // sem moedas suficientes (ou sem linha de estatísticas ainda)
            coins = (long)res;
        }
        int qty;
        await using (var cmd = new Npgsql.NpgsqlCommand("""
            INSERT INTO account_items (account_id, item, qty) VALUES ($1, $2, 1)
            ON CONFLICT (account_id, item) DO UPDATE SET qty = account_items.qty + 1
            RETURNING qty
            """, conn, tx))
        {
            cmd.Parameters.AddWithValue(accountId);
            cmd.Parameters.AddWithValue(item);
            qty = (int)(await cmd.ExecuteScalarAsync())!;
        }
        await tx.CommitAsync();
        return (coins, qty);
    }

    // Gasta uma unidade do item (só se houver). Devolve a quantidade que sobrou, ou null se não tinha.
    public async Task<int?> ConsumeItemAsync(long accountId, string item)
    {
        await using var cmd = Source.CreateCommand("UPDATE account_items SET qty = qty - 1 WHERE account_id = $1 AND item = $2 AND qty > 0 RETURNING qty");
        cmd.Parameters.AddWithValue(accountId);
        cmd.Parameters.AddWithValue(item);
        var res = await cmd.ExecuteScalarAsync();
        return res is null ? null : (int)res;
    }

    public async Task SaveActivePotionAsync(long accountId, string? potion)
    {
        await using var cmd = Source.CreateCommand("""
            INSERT INTO account_profile (account_id, active_potion) VALUES ($1, $2)
            ON CONFLICT (account_id) DO UPDATE SET active_potion = EXCLUDED.active_potion, updated_at = now()
            """);
        cmd.Parameters.AddWithValue(accountId);
        cmd.Parameters.AddWithValue((object?)potion ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync();
    }

    // Ranking permanente: quem tem mais pontos de combate
    public async Task<List<RankingRow>> TopAsync(int limit)
    {
        var list = new List<RankingRow>();
        await using var cmd = Source.CreateCommand("""
            SELECT a.id, a.display_name, s.points, s.slime_kills, s.player_kills
            FROM account_stats s JOIN accounts a ON a.id = s.account_id
            WHERE s.points > 0 ORDER BY s.points DESC, a.id LIMIT $1
            """);
        cmd.Parameters.AddWithValue(limit);
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new RankingRow(r.GetInt64(0), r.GetString(1), r.GetInt64(2), r.GetInt32(3), r.GetInt32(4)));
        return list;
    }

    public async Task<Account?> GetAccountAsync(long id)
    {
        await using var cmd = Source.CreateCommand("SELECT id, display_name, picture FROM accounts WHERE id = $1");
        cmd.Parameters.AddWithValue(id);
        await using var r = await cmd.ExecuteReaderAsync();
        return await r.ReadAsync() ? new Account(r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)) : null;
    }

    // Teste de saúde: abre conexão, lê a hora do banco e a versão do esquema
    public async Task<object> HealthAsync()
    {
        if (_source is null) return new { enabled = false, ok = false, message = "DATABASE_URL não configurada neste servidor." };
        var sw = Stopwatch.StartNew();
        try
        {
            await using var cmd = _source.CreateCommand("SELECT now(), (SELECT value FROM app_meta WHERE key = 'schema_version')");
            await using var reader = await cmd.ExecuteReaderAsync();
            await reader.ReadAsync();
            return new { enabled = true, ok = true, serverTime = reader.GetDateTime(0), schemaVersion = reader.IsDBNull(1) ? null : reader.GetString(1), latencyMs = sw.ElapsedMilliseconds };
        }
        catch (Exception e)
        {
            // não devolve detalhes da conexão (podem conter dados sensíveis); só o tipo do erro
            return new { enabled = true, ok = false, message = "Falha ao falar com o banco: " + e.GetType().Name, latencyMs = sw.ElapsedMilliseconds };
        }
    }
}
