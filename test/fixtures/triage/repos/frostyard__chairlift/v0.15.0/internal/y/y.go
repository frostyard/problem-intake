package y

// T holds a method that is named like a closure suffix.
type T struct{}

// func1 is a pointer method that is named like a closure suffix: it is its own
// parent, with no closure depth.
func (t *T) func1() {}

// Use keeps func1 reachable.
func Use(t *T) {
	t.func1()
}
