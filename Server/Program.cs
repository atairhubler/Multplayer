var builder = WebApplication.CreateBuilder(args);

// Origens permitidas (ex.: "https://usuario.github.io"), separadas por vírgula.
// Vazio = aceita qualquer origem (apenas para desenvolvimento local).
var allowedOrigins = (Environment.GetEnvironmentVariable("ALLOWED_ORIGINS") ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 64 * 1024); // avatares estáticos pequenos enviados como data URL
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
{
    if (allowedOrigins.Length > 0) p.WithOrigins(allowedOrigins);
    else p.SetIsOriginAllowed(_ => true);
    p.AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

var app = builder.Build();

app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles(); // serve o cliente em wwwroot (uso local)

app.MapGet("/health", () => "ok"); // para ping de keep-alive

// Upload de avatar (GIF animado): corpo = bytes do arquivo; devolve a URL relativa
app.MapPost("/avatars", async (HttpRequest req) =>
{
    if (req.ContentLength is > AvatarStore.MaxBytes) return Results.StatusCode(413);
    using var ms = new MemoryStream();
    var buffer = new byte[16 * 1024];
    int n;
    while ((n = await req.Body.ReadAsync(buffer)) > 0)
    {
        ms.Write(buffer, 0, n);
        if (ms.Length > AvatarStore.MaxBytes) return Results.StatusCode(413);
    }
    var id = AvatarStore.Add(ms.ToArray());
    return id is null ? Results.BadRequest("Imagem inválida ou muito grande.") : Results.Ok(new { url = $"/avatars/{id}" });
});

app.MapGet("/avatars/{id}", (string id, HttpContext ctx) =>
{
    if (AvatarStore.Get(id) is not var (data, type)) return Results.NotFound();
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Cache-Control"] = "public, max-age=3600";
    return Results.File(data, type);
});
app.MapHub<GameHub>("/gamehub");

// Render define PORT; localmente usa 5000
var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
app.Run($"http://0.0.0.0:{port}");
