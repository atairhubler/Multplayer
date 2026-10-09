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
