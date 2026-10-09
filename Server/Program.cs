var builder = WebApplication.CreateBuilder(args);

// Origens permitidas (ex.: "https://usuario.github.io"), separadas por vírgula.
// Vazio = aceita qualquer origem (apenas para desenvolvimento local).
var allowedOrigins = (Environment.GetEnvironmentVariable("ALLOWED_ORIGINS") ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

builder.Services.AddSignalR();
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
app.MapHub<GameHub>("/gamehub");

// Render define PORT; localmente usa 5000
var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
app.Run($"http://0.0.0.0:{port}");
