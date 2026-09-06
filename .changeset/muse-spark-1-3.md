---
"@in-the-loop-labs/pair-review": patch
---

Muse: move the built-in models from Muse Spark 1.2 to Muse Spark 1.3 (`muse-spark-1.3-max`, `-xhigh`, `-high`, `-low` and their `-contributor` twins; default `muse-spark-1.3-high`). 1.3 is priced identically to 1.2 and strictly better, so every `muse-spark-1.2-*` id is kept as an alias that resolves to its 1.3 twin at the same reasoning effort — saved councils and configs upgrade in place. The top effort is now `max` (which actually runs) instead of `ultra`, which the CLI gate-closes and silently degrades to `xhigh`; the former `-ultra` ids resolve to the `-max` entries. Docs no longer list the rejected `none` effort.
