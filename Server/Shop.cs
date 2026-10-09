// Loja: itens à venda (por enquanto só poções). O servidor é quem decide preços e efeitos; o cliente só mostra e pede.
public record ShopItem(string Id, string Name, string Description, int Price, string Resource, int Amount);

public static class Shop
{
    // Resource: o que a poção recupera (a vida é do servidor; mana e stamina o cliente aplica ao receber o "ok").
    public static readonly ShopItem[] Items =
    {
        new("life", "Poção de Vida", "Recupera 40 de vida (só faz efeito na arena e na floresta).", 12, "life", 40),
        new("mana", "Poção de Mana", "Recupera 50 de mana.", 10, "mana", 50),
        new("stamina", "Poção de Stamina", "Recupera 60 de stamina.", 10, "stamina", 60),
    };

    public static ShopItem? Find(string? id) => Items.FirstOrDefault(i => i.Id == id);
}
