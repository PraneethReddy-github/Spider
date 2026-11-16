package routes

import (
	"github.com/gin-gonic/gin"

	"example.com/shop/internal/store"
)

// RegisterAdmin mounts admin routes on a group created by the caller.
func RegisterAdmin(g *gin.RouterGroup, s *store.Store) {
	g.GET("/stats", stats)
	g.DELETE("/users/:id", func(c *gin.Context) {
		s.Save(nil)
	})
}

func stats(c *gin.Context) {
	c.String(200, "ok")
}
