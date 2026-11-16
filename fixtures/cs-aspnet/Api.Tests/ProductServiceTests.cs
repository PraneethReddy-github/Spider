using Api.Services;
using Xunit;

namespace Api.Tests;

public class ProductServiceTests
{
    [Fact]
    public void ListsProducts()
    {
        var service = new ProductService();
        service.All();
    }
}
