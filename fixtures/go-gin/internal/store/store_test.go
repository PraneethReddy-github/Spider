package store

import "testing"

func TestFindUser(t *testing.T) {
	s := NewStore()
	if _, err := s.FindUser("1"); err != nil {
		t.Fatal(err)
	}
}
