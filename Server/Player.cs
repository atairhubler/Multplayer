public class Player
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore] public long? AccountId { get; set; } // conta (login com Google); nunca vai para os outros jogadores
    [System.Text.Json.Serialization.JsonIgnore] public string? ActivePotion { get; set; } // poção do botão rápido (life|mana|stamina)
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
