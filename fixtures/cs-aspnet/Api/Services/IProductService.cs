using Api.Models;

namespace Api.Services
{
    public interface IProductService
    {
        IEnumerable<Product> All();
        Product? Find(int id);
        Product Add(Product product);
    }
}
