# How to use a local docker image with MSB

## Start a local registry
REGISTRY_LOCAL_PORT=5123
docker run -d -p $REGISTRY_LOCAL_PORT:5000 --name registry registry:2

## Buikd the image
docker build .
docker tag sha256:30d84bc37c64c1f38cb2221d97860fc1641f067f80cbd5b48cc956b32cca405c localhost:$REGISTRY_LOCAL_PORT/devbox:latest
docker push localhost:$REGISTRY_LOCAL_PORT/devbox:latest

## Import it into  msb images
msb pull --insecure localhost:$REGISTRY_LOCAL_PORT/devbox:latest

## List msb images
```shell
$ msb images
REFERENCE                       DIGEST                 SIZE         CREATED
localhost:5123/devbox:latest    sha256:bfbf2cb9cdf0    369.2 MiB    2026-05-23 08:37:15
```