# Statement retention reproduction

Local evidence: September 13, 2026, macOS arm64, Node 24.12.0. Patched source is pinned to `046e9cbf67d22491e8ecc941ec2891b02a9f3cad`, built with Rust 1.88 and the locked upstream dependencies. These observations are host evidence; Linux installed-package qualification requires the CI matrix.

Run after `npm ci`, `npm run native:build`, and `npm run build`:

```sh
node scripts/native-memory.mjs --mode=official-only
npm run test:memory
```

Each mode runs in a fresh child and database. It performs 100,000 reads and 100,000 updates of one fixed-size row, explicitly closes each statement, uses batches of at most 256 statements per transaction, and forces GC/yields every 2,048 operations. The persisted row must end at `n=100000`, with the original payload and exactly one row.

The original binding with recycling disabled grew from 28,068,480 to 449,449,584 bytes of physical footprint: **401.9 MiB growth**. Retained JS heap changed from 5,512,656 to 5,751,824 bytes. Its final RSS was 189,743,104 bytes while the footprint report included 306,905,088 swapped/compressed bytes. RSS alone obscures much of this growth.

The qualified protected runs were:

| Binding | Recycling | Final physical footprint | Largest final-window growth | Replacements |
| --- | --- | ---: | ---: | ---: |
| `0.7.2-bassfish.1` | disabled | 33.9 MiB | 16 KiB | 0 |
| official `0.7.2` | enabled | 40.2 MiB | 48 KiB | 48 |
| `0.7.2-bassfish.1` | enabled | 34.0 MiB | 32 KiB | 48 |

Each protected run satisfied the 512 MiB ceiling, bounded registry/prepare checks, persisted-value checks, and the 10-second shutdown deadline. Complete shutdown, reopen validation, and the second close took about 15 ms. Allocator and OS paging behavior vary; these numbers are observations rather than a promise of process size.

The native test retains both a JS-wrapped statement and a raw native statement across 10,000 subsequent prepares. Expired registry entries remain below 512, both live statements execute afterward, and raw stepping after database close reports that the statement was finalized. The Rust test separately verifies cadence when more than 256 handles remain live.

The original `DatabaseInner.stmts` appends `Weak<RefCell<Option<turso_core::Statement>>>` on every prepare. Explicit statement finalization and JS GC remove strong owners, but the weak references retain backing Arc allocations until the registry is dropped. `upstream-pruning.patch` drops expired weak references every 256 prepares while preserving live references for database close. It can be applied and tested independently of Bassfish's connection recycling and diagnostic identity.
