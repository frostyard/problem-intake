package store

// Drop exists in the first release only: its frame must be dropped at a tag
// that has no such function, and the problem key must not change.
func (s *Store) Drop() error {
	return nil
}
