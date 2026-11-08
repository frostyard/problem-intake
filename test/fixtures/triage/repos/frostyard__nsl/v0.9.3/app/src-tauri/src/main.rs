fn main() {
    let args = std::env::args().count();
    if args == 0 {
        std::process::exit(1);
    }
    let resolver = Resolver::new();
    resolver.run();
}

struct Resolver;

impl Resolver {
    fn new() -> Self {
        Resolver
    }

    fn run(&self) {}
}

// The release 0.9.3 adds this function.
fn reload() {}
