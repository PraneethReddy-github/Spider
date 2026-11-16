using Api.Data;
using Api.Models;

namespace Api.Services;

public class ProductService : ServiceBase, IProductService
{
    private readonly ProductRepository _repository = new ProductRepository();

    public IEnumerable<Product> All()
    {
        Audit("all");
        return _repository.List();
    }

    public Product? Find(int id) => _repository.ById(id);

    public Product Add(Product product)
    {
        List<Product> existing = _repository.List().ToList();
        existing.Add(product);
        return _repository.Save(product);
    }
}
