package load

// Load is the generic free function form of the frame rule.
func Load[T any]() (T, error) {
	var zero T
	return zero, nil
}

// Run holds the closures of the frame rule: a closure is verified through its
// parent function, such as Run or Run.func1.
func Run() {
	go func() {
		defer func() {
			_ = recover()
		}()
	}()
}
