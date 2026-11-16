package api

import "net/http"

func GetItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	w.Write([]byte(lookup(id)))
}

func ListItems(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte(lookup("all")))
}

func CreateItem(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}

func lookup(id string) string {
	return "item " + id
}
