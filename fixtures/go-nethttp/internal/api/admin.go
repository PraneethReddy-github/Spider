package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// AdminRouter is mounted under /admin by the server.
func AdminRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/stats", stats)
	return r
}

func stats(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte(lookup("stats")))
}
