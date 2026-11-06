package main

import "github.com/frostyard/chairlift/v2/internal/store"

func main() {
	s := &store.Store{}
	_ = s.Write()
	_ = store.Migrate()
}
