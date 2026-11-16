package main

import (
	"github.com/gin-gonic/gin"

	"example.com/shop/internal/handlers"
	"example.com/shop/internal/routes"
	"example.com/shop/internal/store"
)

func main() {
	s := store.NewStore()
	h := handlers.NewUserHandler(s)
	r := gin.Default()
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true})
	})
	api := r.Group("/api")
	v1 := api.Group("/v1")
	{
		v1.GET("/users/:id", h.Get)
		v1.POST("/users", h.Create)
	}
	routes.RegisterAdmin(api.Group("/admin"), s)
	r.Run(":8080")
}
