# NOTE: this image definition has not been built in the development environment this repository
# was created in (no Docker available there). The same sources are compiled and tested natively.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.Version=${VERSION}" -o /out/lan-collector ./cmd/lan-collector

FROM alpine:3.22
# iproute2: `ip neigh` gives neighbour-table freshness (REACHABLE/STALE).
RUN apk add --no-cache ca-certificates iproute2 && adduser -D -H -u 10001 collector \
    && mkdir -p /var/lib/lan-collector && chown collector /var/lib/lan-collector
COPY --from=build /out/lan-collector /usr/local/bin/lan-collector
USER collector
ENV LAN_COLLECTOR_STATE_DIR=/var/lib/lan-collector
VOLUME /var/lib/lan-collector
# Run with:  --network host  (the collector must see the LAN's layer 2 to read MAC addresses)
#            --cap-add NET_RAW (ICMP), or allow unprivileged ping via net.ipv4.ping_group_range
ENTRYPOINT ["/usr/local/bin/lan-collector"]
