# Bassfish's Turso binding

This directory tracks the source and patch for `0.7.2-bassfish.1`. The engine is Turso 0.7.2, pinned to `046e9cbf67d22491e8ecc941ec2891b02a9f3cad`. `source.json` pins the source archive, upstream Cargo.lock, Rust 1.88 toolchain file, and `release-official` profile. The upstream MIT license is in `LICENSE.md`.

`statement-registry.patch` prunes expired weak statement handles every 256 successful calls to the native `prepare` API. Its separate cadence counter avoids scanning on every prepare when many handles remain live. Live handles remain registered so database close still finalizes them. It also exposes a build identity and content-free registry statistics. The engine, database format, MVCC, durability, and transaction behavior are unchanged.

## Build and package

On Apple Silicon macOS or glibc Linux arm64/x64, install Node 24.12.0, rustup, Git, curl, a C/C++ compiler, and the platform linker. Then run:

```sh
npm ci
npm run native:build
npm run build
npm run package:check:host
```

The build verifies the pinned source hashes, applies the patch, runs its Rust registry test, and builds with `cargo --locked` and Rust 1.88. It writes the host binary and its metadata to the ignored `artifacts/` directory. Source and Cargo build cache live under `.tmp/native-build`. Delete that directory for a clean rebuild. Metadata records source, lockfile, toolchain and patch hashes, target, binary hash, build time, and actual compiler/OS/Node/glibc versions. Reproducible here means pinned source, toolchain and dependencies; platform compiler/linker versions and build paths can affect binary bytes.

`.github/workflows/native.yml` builds all three native targets on their matching runners. Qualification jobs merge the three artifacts, build a release, and test that complete package's installed tarball on each platform. No install hook downloads or compiles native code.

```sh
# After merging native-* CI artifacts into native/turso/artifacts:
npm run build:release
npm run package:check
```

`build` is a host-only development build. `build:release` and `prepack` require all three binaries. Release packaging verifies metadata and SHA-256 hashes, and bundles the binaries, manifest, license, and patch under `dist/native`. Tarballs must be at most 64 MiB compressed. The loader selects only the matching verified binary and checks its native build identity; it has no environment override or fallback to the official dependency. Missing or incompatible artifacts fail with `STORAGE_UNAVAILABLE`.

## Upstream patch and reproduction

`upstream-pruning.patch` contains the pruning fix and Rust test without Bassfish's identity or diagnostics. Apply it to the pinned upstream checkout using `git apply`, then run:

```sh
cargo +1.88 test --locked -p turso_node --lib registry_prunes_dead_handles
```

The Rust test proves dead handles disappear, live handles survive, and more than 256 live handles do not cause pruning on every prepare. Bassfish's native child-process test also executes a live statement after thousands of prepares, then verifies database close finalizes it.

```sh
npm run build
# Official binding, explicit statement close and GC, recycling disabled:
node scripts/native-memory.mjs --mode=official-only
# Each protection independently, then both together:
npm run test:memory
```

The official-only mode prints memory samples as an observational reproduction rather than applying the patched acceptance window. Weak references keep Arc allocation/control blocks alive after JS GC and statement finalization; this registry grows with the lifetime number of prepares in the original binding. Each child reads and updates a fixed one-row dataset 100,000 times, samples after explicit GC/yields, and verifies the persisted value. The official native package is a development dependency only. On macOS these scripts use `footprint` to include compressed/swapped accounting and require process-inspection permission. No upstream PR or message is sent by these scripts.

See [local reproduction evidence](reproduction.md) for measured results and native live-handle checks.
