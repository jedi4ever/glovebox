
  NAME=$(printf '%s' "$PWD" | openssl dgst -sha256 | awk '{print "cc-msb-dir-" substr($NF,1,12)}')
  msb stop "$NAME" --quiet 2>/dev/null
  msb remove "$NAME" --quiet
