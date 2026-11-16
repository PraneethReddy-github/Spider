package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"google.golang.org/grpc"

	"example.com/svc/internal/api"
	"example.com/svc/internal/greeter"
	pb "example.com/svc/proto/hello"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", api.GetItem)
	mux.Handle("/static/", http.FileServer(http.Dir(".")))

	r := chi.NewRouter()
	r.Route("/v2", func(r chi.Router) {
		r.Get("/items", api.ListItems)
		r.Post("/items", api.CreateItem)
	})
	r.Mount("/admin", api.AdminRouter())

	s := grpc.NewServer()
	pb.RegisterGreeterServer(s, &greeter.Server{})
	http.ListenAndServe(":8080", r)
}
