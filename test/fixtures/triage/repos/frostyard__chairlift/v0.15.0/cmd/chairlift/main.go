package main

import "github.com/frostyard/chairlift/internal/store"

func main() {
	s := &store.Store{}
	_ = s.Write()
	_ = store.Migrate()
}
