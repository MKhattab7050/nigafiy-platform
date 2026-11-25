# The Nigafiy Sensor image: the one Nigafiy executable (nigafiy-engine) run as `nigafiy-engine sensor`
# (docs/architecture/engine-sensor.md). Build it from the REPOSITORY ROOT, because the executable
# needs both engine/ and collectors/lan-collector/:
#
#   docker build -f collectors/lan-collector/Dockerfile -t nigafiy/sensor .
#   docker buildx build --platform linux/arm64 -f collectors/lan-collector/Dockerfile -t nigafiy/sensor .
#
# Dockerfile.dockerignore (next to this file) keeps everything else out of the build context.
#
# NOTE: this image definition has not been built in the development environment this repository
# was created in (no Docker available there). The same sources are compiled (CGO off, linux
# amd64 and arm64) and tested natively.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY collectors/lan-collector/go.mod collectors/lan-collector/go.sum collectors/lan-collector/
COPY engine/go.mod engine/go.sum engine/
RUN cd engine && go mod download
COPY collectors/lan-collector collectors/lan-collector
COPY engine engine
ARG VERSION=1.0.3
RUN cd engine && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.Version=${VERSION}" -o /out/nigafiy-engine ./cmd/nigafiy-engine

FROM alpine:3.22
# iproute2: `ip neigh` gives neighbour-table freshness (REACHABLE/STALE).
RUN apk add --no-cache ca-certificates iproute2 && adduser -D -H -u 10001 collector \
    && mkdir -p /var/lib/lan-collector && chown collector /var/lib/lan-collector
COPY --from=build /out/nigafiy-engine /usr/local/bin/nigafiy-engine
# The old program names run the Sensor too (the executable checks its own name), so an
# `--entrypoint /usr/local/bin/nigafiy-sensor` from before the merge keeps working.
RUN ln -s nigafiy-engine /usr/local/bin/nigafiy-sensor && ln -s nigafiy-engine /usr/local/bin/lan-collector
USER collector
ENV NIGAFIY_SENSOR_STATE_DIR=/var/lib/lan-collector
VOLUME /var/lib/lan-collector
# Run with:  --network host  (the Sensor must see the LAN's layer 2 to read MAC addresses)
#            --cap-add NET_RAW (ICMP), or allow unprivileged ping via net.ipv4.ping_group_range
# Arguments after the image name go to the Sensor, as before: docker run … nigafiy/sensor -config /etc/x.yaml
ENTRYPOINT ["/usr/local/bin/nigafiy-engine", "sensor"]
