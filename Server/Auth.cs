using System.Security.Cryptography;
using System.Text;
using Google.Apis.Auth;

// Login com Google: o navegador entrega um "ID token" do Google; o servidor confere com o Google (assinatura, validade e se o token
// foi emitido para o NOSSO ID de cliente), cria/atualiza a conta no banco e devolve uma sessão própria (válida por 30 dias).
// A sessão é assinada com um segredo do servidor (variável SESSION_SECRET no Render) e guardada no navegador do jogador.

public record GoogleLoginRequest(string? Credential);
public record Account(long Id, string Name, string? Picture);
public record AccountStats(long Points, int PlayerKills, int SlimeKills, int Deaths, long Coins);
public record AccountData(AccountStats Stats, List<string> Titles, string? NameColor, string? EquippedTitle, string? Character);
public record RankingRow(long AccountId, string Name, long Points, int SlimeKills, int PlayerKills);

public sealed class Sessions
{
    private readonly byte[] _key;

    public Sessions()
    {
        var secret = Environment.GetEnvironmentVariable("SESSION_SECRET");
        if (string.IsNullOrWhiteSpace(secret) || secret.Length < 24)
        {
            _key = RandomNumberGenerator.GetBytes(32);
            Console.WriteLine("[auth] SESSION_SECRET ausente ou curta: usando uma chave aleatória (as sessões caem a cada reinício do servidor).");
        }
        else _key = Encoding.UTF8.GetBytes(secret);
    }

    // formato: v1.<contaId>.<expira em segundos (unix)>.<assinatura HMAC-SHA256 em base64url>
    public string Create(long accountId, TimeSpan life)
    {
        var payload = $"v1.{accountId}.{DateTimeOffset.UtcNow.Add(life).ToUnixTimeSeconds()}";
        return payload + "." + Sign(payload);
    }

    public long? Verify(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return null;
        var parts = token.Split('.');
        if (parts.Length != 4 || parts[0] != "v1") return null;
        var expected = Sign($"{parts[0]}.{parts[1]}.{parts[2]}");
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(parts[3]))) return null;
        if (!long.TryParse(parts[1], out var id) || !long.TryParse(parts[2], out var exp)) return null;
        return exp > DateTimeOffset.UtcNow.ToUnixTimeSeconds() ? id : null;
    }

    private string Sign(string payload) =>
        Convert.ToBase64String(HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(payload))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public static class GoogleAuth
{
    // ID de cliente do Google (público, não é segredo). Pode ser trocado pela variável GOOGLE_CLIENT_ID.
    public static readonly string ClientId =
        Environment.GetEnvironmentVariable("GOOGLE_CLIENT_ID") ?? "872095404882-v2799p9gu2qv973b1hc2g1bcigm93d49.apps.googleusercontent.com";

    public static void Map(WebApplication app)
    {
        app.MapPost("/auth/google", async (GoogleLoginRequest req, Db db, Sessions sessions) =>
        {
            if (!db.Enabled) return Results.Json(new { error = "O banco de dados não está disponível no servidor." }, statusCode: 503);
            if (string.IsNullOrWhiteSpace(req.Credential) || req.Credential.Length > 4096) return Results.Json(new { error = "Credencial ausente." }, statusCode: 400);

            GoogleJsonWebSignature.Payload payload;
            try
            {
                payload = await GoogleJsonWebSignature.ValidateAsync(req.Credential,
                    new GoogleJsonWebSignature.ValidationSettings { Audience = new[] { ClientId } });
            }
            catch (InvalidJwtException) { return Results.Json(new { error = "O Google recusou a credencial. Tente entrar de novo." }, statusCode: 401); }

            try
            {
                var name = string.IsNullOrWhiteSpace(payload.GivenName) ? (payload.Name ?? "Jogador") : payload.GivenName;
                var account = await db.UpsertAccountAsync(payload.Subject, payload.Email, name.Trim(), payload.Picture);
                // aparência e cor do nome salvas: o cliente preenche a tela de entrada com elas (o mesmo personagem em qualquer aparelho)
                var saved = await db.LoadAccountDataAsync(account.Id);
                return Results.Ok(new
                {
                    token = sessions.Create(account.Id, TimeSpan.FromDays(30)),
                    account = new { name = account.Name, picture = account.Picture, character = saved.Character, nameColor = saved.NameColor },
                });
            }
            catch (Exception)
            {
                return Results.Json(new { error = "Não consegui salvar a sua conta. Tente de novo em instantes." }, statusCode: 503);
            }
        });
    }
}
