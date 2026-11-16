package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func fetchItem(id string) (*http.Response, error) {
	return http.Get("http://catalog:8000/items/" + id)
}

func getOrder(c *gin.Context) {
	fetchItem(c.Param("id"))
}

func createOrder(c *gin.Context) {}

func cancelOrder(c *gin.Context) {}

func reserve(c *gin.Context) {}

func main() {
	r := gin.Default()
	r.GET("/health", func(c *gin.Context) {})
	r.GET("/orders/:id", getOrder)
	r.POST("/orders", createOrder)
	r.DELETE("/orders/:id", cancelOrder)
	r.POST("/orders/:id/reserve", reserve)
	r.Run(":8080")
}

// Not client calls: a ServeMux registration and an authorisation check that takes a method and a path.
type API struct{}

func (api *API) authorize(method, path string) bool { return method != "" && path != "" }

func (api *API) admin() {
	mux := http.NewServeMux()
	mux.HandleFunc("/admin/stats", func(w http.ResponseWriter, r *http.Request) {})
	api.authorize(http.MethodPost, "/orders")
}
