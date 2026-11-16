using Microsoft.EntityFrameworkCore;

namespace Shop;

public class Customer
{
    public int Id { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers { get; set; }
}

public class CustomerService
{
    private readonly ShopContext _db;

    public CustomerService(ShopContext db) { _db = db; }

    public void Add(Customer c) => _db.Customers.Add(c);

    public int Count() => _db.Customers.Count();
}
