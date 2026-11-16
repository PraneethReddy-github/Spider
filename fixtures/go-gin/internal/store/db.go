package store

import "fmt"

type DB struct{}

type User struct {
	ID string
}

func openDB() *DB {
	return &DB{}
}

func (d *DB) Query(id string) (*User, error) {
	return &User{ID: id}, nil
}

func (d *DB) Exec(stmt string, args ...string) {
	fmt.Println(stmt, args)
}
