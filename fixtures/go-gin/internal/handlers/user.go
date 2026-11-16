package handlers

import (
	"github.com/gin-gonic/gin"

	"example.com/shop/internal/store"
)

// UserHandler serves user endpoints.
type UserHandler struct {
	Base
	store *store.Store
}

func NewUserHandler(s *store.Store) *UserHandler {
	return &UserHandler{store: s}
}

func (h *UserHandler) Get(c *gin.Context) {
	u, err := h.store.FindUser(c.Param("id"))
	if err != nil {
		c.AbortWithStatus(404)
		return
	}
	h.respond(c, u)
}

func (h *UserHandler) Create(c *gin.Context) {
	u := store.User{ID: c.PostForm("id")}
	h.store.Save(&u)
	h.Log("created")
}
