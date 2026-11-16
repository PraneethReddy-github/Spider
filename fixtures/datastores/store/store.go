package store

import "gorm.io/gorm"

type Product struct {
	ID   uint
	Name string
}

type Store struct {
	db *gorm.DB
}

func (s *Store) List() {
	s.db.Find(&[]Product{})
}

func (s *Store) Add(name string) {
	s.db.Create(&Product{Name: name})
}

func (s *Store) Cheap() {
	s.db.Raw("SELECT * FROM products WHERE price < ?", 10)
}
