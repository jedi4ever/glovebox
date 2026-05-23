
use in conductor - wrapper script

===
config file change / dir container
====
- websearch override ?
- stream shell output or reads
====
- allow all yolo mode
- disable memory, setting corporate
====
- env file loading
- env var specified
- env setting
===
dynamic agent container images
===
- secrets filtering, setting
- block reads.write

- pre-session script in sandbox

- __HOST__ scope
_ __HOST__ in bash command
enable/disable it

-  mapping local/remote command

- shadow write directory
- mount directoru specified

- make it skill
- disk size, memory , cpu


The next CC tool call from ~/dev/opo will recreate it using the current global config and write the fingerprint. From
  then on, every future global edit will be caught.

  Real fix — there's a better design we could implement: instead of our own fingerprint file, read the actual sandbox
  config via msb inspect <name> --format json (you saw the output earlier: image, mounts, network policy with rules, ports,
   …) and compare that to the current effective config. That sidesteps the migration problem entirely — works for every
  sandbox, including pre-existing ones, with no baseline file needed. The one limitation is that --secret values don't
  appear in inspect (they're proxy-side), so secret value changes can't be detected — only their presence. Everything else
  can.

  Want me to swap the fingerprint approach for the inspect-based one? It's roughly the same code size, more robust, no
  migration story.