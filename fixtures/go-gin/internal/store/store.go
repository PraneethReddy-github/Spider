package store

type Store struct {
	db *DB
}

func NewStore() *Store {
	return &Store{db: openDB()}
}

func (s *Store) FindUser(id string) (*User, error) {
	return s.db.Query(id)
}

func (s *Store) Save(u *User) error {
	s.db.Exec("insert", u.ID)
	return nil
}
