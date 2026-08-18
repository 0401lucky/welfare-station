# ---- Stage 1: build frontend ----
FROM node:20-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ .
RUN npm run build

# ---- Stage 2: build backend (embeds web/dist) ----
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Copy the freshly built frontend into the embed location.
COPY --from=web /app/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/welfare .

# ---- Stage 3: minimal runtime image ----
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S welfare && adduser -S welfare -G welfare
WORKDIR /app
COPY --from=build /out/welfare /app/welfare
# The runtime image is designed to connect to an external MySQL instance.
USER welfare
EXPOSE 8080
ENTRYPOINT ["/app/welfare"]
