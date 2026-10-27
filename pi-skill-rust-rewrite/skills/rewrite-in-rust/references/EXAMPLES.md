# Worked Rust examples

Longer examples that back the rules in [SKILL.md](../SKILL.md). Read the example for the rule you are applying; do not copy an example into a project without checking the source evidence it assumes.

Each example compiles on current stable Rust with `cargo clippy -- -D warnings` when placed in a scratch library crate with the stubs named in its introduction.

## Reference fixtures recorded from the pinned original

Rule: compare bytes, not lossy strings, against outputs the original produced at the pinned revision. Stub needed: `parser::render(&[u8]) -> Vec<u8>`.

```rust
// tests/reference.rs: each `*.expected` file was produced by the original at the pinned revision.
use std::{fs, path::Path};

#[test]
fn matches_reference_outputs() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for entry in fs::read_dir(&fixtures).unwrap() {
        let input = entry.unwrap().path();
        if input.extension().is_none_or(|ext| ext != "in") {
            continue;
        }
        let expected = fs::read(input.with_extension("expected")).unwrap();
        let actual = parser::render(&fs::read(&input).unwrap());
        assert_eq!(actual, expected, "output differs for {}", input.display());
    }
}
```

Before trusting this test, break one `.expected` file on purpose and confirm the test fails. A judge that cannot reject a wrong implementation is not a judge.

## Back-pointers without unsafe: an arena with typed indices

Rule R-OWN-03 in the sample rulebook: `node->parent` becomes `Option<NodeId>` into an arena; no `Rc`, no raw pointers. Inventory row that justified it:

```text
src/tree.c:88 node->parent | owner: Tree | borrowers: walk(), find_root() | mutation: reparent() only
escape: none | threads: single | Rust: Option<NodeId> | evidence: tree_free() frees every node | open: none
```

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeId(usize);

#[derive(Debug)]
struct Node {
    parent: Option<NodeId>,
    children: Vec<NodeId>,
    name: String,
}

#[derive(Debug, Default)]
pub struct Tree {
    nodes: Vec<Node>,
}

impl Tree {
    pub fn add(&mut self, parent: Option<NodeId>, name: impl Into<String>) -> NodeId {
        let id = NodeId(self.nodes.len());
        self.nodes.push(Node { parent, children: Vec::new(), name: name.into() });
        if let Some(parent) = parent {
            self.nodes[parent.0].children.push(id);
        }
        id
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.nodes[id.0].parent
    }

    pub fn name(&self, id: NodeId) -> &str {
        &self.nodes[id.0].name
    }
}
```

The `Tree` owns every node, so teardown is a single drop and the back-pointer needs no `unsafe`. If nodes can be removed while IDs are still held, use generational indices, for example an existing slab or slot-map crate, so a stale ID fails instead of aliasing a new node.

## Status codes become a typed error, exit codes stay at the boundary

Rule R-ERR-01: C status codes become `Result<T, ParseError>`; only the CLI maps variants back to exit codes. Stubs needed: `pub struct Config;` and `fn parse_config(&str) -> Result<Config, ConfigError>`.

```c
/* returns 0 on success, -1 on I/O error (errno set), -2 on syntax error */
int load_config(const char *path, struct config *out);
```

```rust
use std::{fmt, fs, io, path::Path};

#[derive(Debug)]
pub enum ConfigError {
    Io(io::Error),
    Syntax { line: usize, message: String },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "cannot read config: {err}"),
            Self::Syntax { line, message } => write!(f, "line {line}: {message}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Syntax { .. } => None,
        }
    }
}

impl From<io::Error> for ConfigError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

pub fn load_config(path: &Path) -> Result<Config, ConfigError> {
    let text = fs::read_to_string(path)?;
    parse_config(&text)
}

impl ConfigError {
    /// Exit status of the original CLI, kept for compatibility (R-ERR-01).
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Io(_) => 1,
            Self::Syntax { .. } => 2,
        }
    }
}
```

If the project already uses an error crate such as `thiserror` or `anyhow`, follow it instead of hand-writing these impls. Use `anyhow`-style opaque errors only in applications, not in library APIs whose callers match on variants.

## A permitted performance block behind a validating type

Unsafe policy, case 2: the block is on a profiled hot path, the best safe version missed the budget, and the invariant is established once by a type with private fields so safe callers cannot break it. Both functions are standalone.

```rust
pub struct ValidatedIndices {
    indices: Vec<usize>,
    bound: usize,
}

impl ValidatedIndices {
    pub fn new(indices: Vec<usize>, bound: usize) -> Option<Self> {
        indices.iter().all(|&i| i < bound).then_some(Self { indices, bound })
    }
}

/// Unsafe register UNS-3: the bounds-checked `gather_checked` missed the decode
/// budget in benchmark `decode_large`. Keep `gather_checked` as the test oracle.
pub fn gather(values: &[f64], idx: &ValidatedIndices) -> f64 {
    assert_eq!(values.len(), idx.bound, "gather: index bound does not match values");
    idx.indices
        .iter()
        // SAFETY: `ValidatedIndices::new` guarantees `i < bound`, and the assertion
        // above guarantees `bound == values.len()`, so every `i` is in range.
        .map(|&i| unsafe { *values.get_unchecked(i) })
        .sum()
}

pub fn gather_checked(values: &[f64], idx: &ValidatedIndices) -> f64 {
    idx.indices.iter().map(|&i| values[i]).sum()
}
```

A differential test must assert `gather == gather_checked` on random inputs, and the register entry must name the benchmark and the revision. Re-measure after toolchain changes and remove the block when the gain disappears.

## An unavoidable FFI boundary inside one safe owning wrapper

Unsafe policy, case 1: the contract retains a native library. All `unsafe` sits in one module, the public type owns the handle, and `Drop` frees it exactly once. The crate must use the current stable edition, which requires `unsafe extern` blocks. Linking is not needed for `cargo check` or `cargo clippy`.

```rust
mod sys {
    use std::ffi::{c_char, c_int};
    use std::marker::{PhantomData, PhantomPinned};

    /// Opaque C type; only ever used behind a pointer.
    #[repr(C)]
    pub struct parser {
        _data: (),
        _marker: PhantomData<(*mut u8, PhantomPinned)>,
    }

    unsafe extern "C" {
        pub fn parser_new() -> *mut parser;
        pub fn parser_feed(p: *mut parser, data: *const c_char, len: usize) -> c_int;
        pub fn parser_free(p: *mut parser);
    }
}

/// Owns one native parser. Not `Send`: the C library is not thread-safe.
pub struct Parser(std::ptr::NonNull<sys::parser>);

impl Parser {
    pub fn new() -> Option<Self> {
        // SAFETY: `parser_new` has no preconditions; null signals allocation failure.
        std::ptr::NonNull::new(unsafe { sys::parser_new() }).map(Self)
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), i32> {
        // SAFETY: `self.0` is live and exclusively borrowed; the library reads exactly
        // `data.len()` bytes and does not keep the pointer after returning.
        let rc = unsafe { sys::parser_feed(self.0.as_ptr(), data.as_ptr().cast(), data.len()) };
        if rc == 0 { Ok(()) } else { Err(rc) }
    }
}

impl Drop for Parser {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from `parser_new` and is freed exactly once, here.
        unsafe { sys::parser_free(self.0.as_ptr()) }
    }
}
```

Generate foreign declarations with the project's binding tool, such as `bindgen` or `cbindgen`, when one exists instead of writing them by hand. Each wrapper like this is one FFI entry in the unsafe register.
