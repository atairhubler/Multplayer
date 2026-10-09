public class Player
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Map { get; set; } = "village"; // "village" (vilarejo), "forest" (floresta) ou "arena"
    public string CharacterSprite { get; set; } = "";
    public float X { get; set; }
    public float Y { get; set; }

    // Personalização e estado social (tudo só em memória, enquanto o jogador está conectado)
    public string? NameColor { get; set; }   // "#rrggbb"
    public string? Title { get; set; }       // um dos títulos permitidos
    public bool Dancing { get; set; }
    public string? RidingOn { get; set; }    // id de quem está carregando este jogador
    public bool Sharing { get; set; }        // está compartilhando a tela na "projeção"
}
