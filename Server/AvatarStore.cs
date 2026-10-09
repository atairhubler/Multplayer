using System.Collections.Concurrent;

// Avatares enviados por upload (GIFs animados), guardados só em memória:
// somem quando o jogador sai ou o servidor reinicia.
public static class AvatarStore
{
    public const int MaxBytes = 3 * 1024 * 1024;       // por arquivo
    private const long MaxTotalBytes = 150L * 1024 * 1024;
    private static readonly TimeSpan UnclaimedTtl = TimeSpan.FromMinutes(10);

    private class Entry
    {
        public required byte[] Data;
        public required string ContentType;
        public DateTime Created = DateTime.UtcNow;
        public string? Owner; // ConnectionId do jogador que usa o avatar
    }

    private static readonly ConcurrentDictionary<string, Entry> Items = new();

    // Valida pelos bytes iniciais (não confia no Content-Type enviado)
    private static string? DetectType(byte[] d)
    {
        bool Starts(params byte[] sig) => d.Length >= sig.Length && d.AsSpan(0, sig.Length).SequenceEqual(sig);
        if (Starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";                       // GIF8
        if (Starts(0x89, 0x50, 0x4E, 0x47)) return "image/png";
        if (Starts(0xFF, 0xD8, 0xFF)) return "image/jpeg";
        if (d.Length > 12 && Starts(0x52, 0x49, 0x46, 0x46) && d[8] == 0x57 && d[9] == 0x45 && d[10] == 0x42 && d[11] == 0x50)
            return "image/webp";
        return null;
    }

    public static string? Add(byte[] data)
    {
        if (data.Length == 0 || data.Length > MaxBytes) return null;
        var type = DetectType(data);
        if (type is null) return null;

        Purge();
        if (Items.Values.Sum(e => (long)e.Data.Length) + data.Length > MaxTotalBytes) return null;

        var id = Guid.NewGuid().ToString("N");
        Items[id] = new Entry { Data = data, ContentType = type };
        return id;
    }

    public static (byte[] Data, string ContentType)? Get(string id) =>
        Items.TryGetValue(id, out var e) ? (e.Data, e.ContentType) : null;

    // Associa o avatar a um jogador; falha se não existe ou já pertence a outro
    public static bool Claim(string id, string connectionId)
    {
        if (!Items.TryGetValue(id, out var e)) return false;
        lock (e)
        {
            if (e.Owner is not null) return false;
            e.Owner = connectionId;
            return true;
        }
    }

    public static void RemoveOwnedBy(string connectionId)
    {
        foreach (var (id, e) in Items)
            if (e.Owner == connectionId) Items.TryRemove(id, out _);
    }

    // Descarta uploads que nunca foram usados para entrar no jogo
    private static void Purge()
    {
        var limit = DateTime.UtcNow - UnclaimedTtl;
        foreach (var (id, e) in Items)
            if (e.Owner is null && e.Created < limit) Items.TryRemove(id, out _);
    }
}
