# Build the cc-msb devbox image, push it to a local OCI registry, and pull it
# into msb's image store. Override any variable on the command line, e.g.
#   make all IMAGE=mybox TAG=v2 REGISTRY_PORT=5000

IMAGE         ?= devbox
TAG           ?= latest
REGISTRY_PORT ?= 5123
REGISTRY      ?= localhost:$(REGISTRY_PORT)
REF           := $(REGISTRY)/$(IMAGE):$(TAG)

.PHONY: all build push pull registry-up registry-down clean

all: build push pull

build:
	docker build -t $(REF) -f Dockerfile .

push:
	docker push $(REF)

pull:
	msb pull --insecure --force $(REF)

registry-up:
	@docker ps --format '{{.Names}}' | grep -q '^registry$$' \
	  || docker run -d -p $(REGISTRY_PORT):5000 --name registry registry:2

registry-down:
	-docker rm -f registry

clean:
	-docker rmi $(REF)
