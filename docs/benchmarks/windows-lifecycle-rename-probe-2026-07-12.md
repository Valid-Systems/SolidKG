# Windows lifecycle rename contention probe - 2026-07-12

This focused local probe validated the lifecycle writer against a real Windows file lock rather than only mocked `fs.renameSync` failures.

## Environment and method

- Platform: Windows (`win32`)
- Build: current local `dist/index-lifecycle-atomic-file.js`
- A PowerShell child opened an existing `index-lifecycle.json` destination with `System.IO.FileShare.None` for 250 ms.
- The parent called `writeAtomicLifecycleFile` while that exclusive lock was active.
- The writer retried the transient rename against the same owned temporary file.
- After the child released the lock, the writer atomically replaced the destination and the probe verified the new contents.

## Result

```json
{"platform":"win32","published":true,"elapsedMs":366}
```

The probe passed. This demonstrates recovery from one real transient destination-lock event on this host; it is not a guarantee for every Windows filesystem, security product, or lock duration. Mocked tests separately cover `EACCES`, `EBUSY`, `EPERM`, exact bounded delays, persistent failure cleanup, and immediate propagation of non-transient errors.
