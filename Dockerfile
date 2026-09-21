# ---- Stage 1: build frontend ----
FROM node:20-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ .
RUN npm run build

# ---- Stage 2: build backend (embeds web/dist) ----
FROM golang:1.25-alpine AS build
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
# 存活探针:/healthz 会 ping 数据库,DB 不可达时返回 503。alpine 自带 busybox wget,没有 curl。
# compose 文件不再重复声明 healthcheck,统一沿用这里的定义。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/app/welfare"]
