using Api.Models;

namespace Api.Data;

public class ProductRepository
{
    private readonly Dictionary<int, Product> _rows = new();

    public IEnumerable<Product> List() => _rows.Values;

    public Product? ById(int id) => _rows.TryGetValue(id, out var p) ? p : null;

    public Product Save(Product product)
    {
        _rows[product.Id] = product;
        return product;
    }
}
