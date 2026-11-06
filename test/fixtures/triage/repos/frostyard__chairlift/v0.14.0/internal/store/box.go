package store

// Box holds the 2 generic receiver forms of the frame rule.
type Box[T any] struct {
	value T
}

// Put is the generic pointer method form: (*Box[...]).Put.
func (b *Box[T]) Put(value T) {
	b.value = value
}

// Get is the generic value method form: Box[...].Get.
func (b Box[T]) Get() T {
	return b.value
}
