namespace Api.Models;

public record Product(int Id, string Name)
{
    public Product WithName(string name) => this with { Name = name };
}
