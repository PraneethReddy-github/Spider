package handlers

import (
	"log"

	"github.com/gin-gonic/gin"

	"example.com/shop/internal/store"
)

type Base struct{}

func (b *Base) Log(msg string) {
	log.Println(msg)
}

// respond lives in a different file than its receiver type.
func (h *UserHandler) respond(c *gin.Context, u *store.User) {
	c.JSON(200, u)
}
