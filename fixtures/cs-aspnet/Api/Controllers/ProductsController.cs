using Api.Models;
using Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    private readonly IProductService _products;

    public ProductsController(IProductService products)
    {
        _products = products;
    }

    [HttpGet]
    public IEnumerable<Product> GetAll() => _products.All();

    [HttpGet("{id}")]
    public ActionResult<Product> Get(int id)
    {
        Product? product = _products.Find(id);
        return product is null ? NotFound() : product;
    }

    [HttpPost]
    public Product Create([FromBody] Product product)
    {
        var created = _products.Add(product);
        return created.WithName(product.Name);
    }

    [HttpDelete("{id:int}")]
    public void Remove(int id) => _products.Find(id);
}
