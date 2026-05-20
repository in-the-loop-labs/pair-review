---
"@in-the-loop-labs/pair-review": patch
---

Honor `availability_command` for chat providers. Built-in providers and dynamic chat providers defined in config can now run a configured probe to determine availability instead of falling back to the generic `<command> --version` check (or, for Pi, the cached AI availability). Also hardens the underlying check: stdout/stderr are discarded to avoid pipe-buffer deadlock on verbose probes, signal-terminated processes are distinguished from non-zero exits, and error messages no longer leak the raw shell command.
