namespace Api.Services;

public abstract class ServiceBase
{
    protected void Audit(string action)
    {
        Console.WriteLine(action);
    }
}
