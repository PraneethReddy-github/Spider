using Api.Data;

namespace Api.Endpoints;

public static class TodoEndpoints
{
    public static IResult List() => Results.Ok(new[] { "a" });

    public static IResult Create(string title)
    {
        Remove(0);
        return Results.Created($"/api/todos/{title}", title);
    }

    public static IResult Remove(int id) => Results.NoContent();
}
