using Api.Endpoints;
using Api.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddSingleton<IProductService, ProductService>();

var app = builder.Build();

app.MapGet("/health", () => "ok");

var todos = app.MapGroup("/api/todos");
todos.MapGet("/", TodoEndpoints.List);
todos.MapPost("/", TodoEndpoints.Create);
todos.MapDelete("/{id}", (int id) => TodoEndpoints.Remove(id));

app.MapControllers();
app.Run();
