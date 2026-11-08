package store

import "errors"

// The code of a failed migration: a string literal, which the reader finds
// with git grep -F.
var errMigrate = errors.New("store.migrate_failed")

// Migrate is the free function form of the frame rule.
func Migrate() error {
	return errMigrate
}

type Store struct {
	name string
}

// Write is the pointer method form of the frame rule.
func (s *Store) Write() error {
	return nil
}

// Read is the value method form of the frame rule.
func (s Store) Read() error {
	return nil
}
