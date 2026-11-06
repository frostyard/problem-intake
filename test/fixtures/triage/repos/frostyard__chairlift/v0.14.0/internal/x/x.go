package x

// func1 is a free function that is named like a closure suffix: it is its own
// parent, with no closure depth.
func func1() {}

// Use keeps func1 reachable.
func Use() {
	func1()
}
